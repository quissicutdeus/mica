import { defineService } from '../lib/defineService';
import type { HodlrHolding } from '@shared/types';
import { fields, requirePositiveInt } from '../lib/payload';
import { getCurrentPrice, getPriceHistory, isMarketReady } from './HodlrMarket';
import { Database } from '../lib/Database';

/**
 * Hodlr: one simulated coin, one holding row per player.
 *
 * `write: 'server'` and every generic action disabled — a holding only ever changes
 * through the `buy`/`sell` actions, which move real money via `FrameworkPlayer` directly
 * rather than `Payments.transfer` (peer-to-peer only, and does not fit a simulated market
 * minting/burning value the way a shop purchase does). The coin's live price and history
 * live in `HodlrMarket.ts`, a plain module rather than another `defineService`, because
 * nobody owns a global price the way a player owns a holding.
 */
export const hodlr = defineService<HodlrHolding>({
  id: 'hodlr',
  access: { read: 'owner', write: 'server' },
  schema: {
    quantity: { type: 'int', notNull: true, default: 0 }
  },
  // One row per player, enforced by the database rather than a find-then-write that can
  // interleave with a concurrent buy and sell.
  indexes: [{ name: 'citizenid_unique', columns: ['citizenid'], unique: true }],
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true },
  /**
   * Price history. Declared here rather than on a separate service, because DDL
   * generation only scans `defineService` declarations and there is no per-player owner
   * to declare a global-price table against. `HodlrMarket.ts` is what actually reads and
   * writes this table.
   */
  childTables: [
    {
      name: 'gphone_hodlr_price_history',
      columns: {
        price: { type: 'int', notNull: true },
        recorded_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [{ name: 'recorded_at', columns: ['recorded_at'] }]
    }
  ]
});

const app = hodlr.app;
const repo = hodlr.repo;

const TRADE_MAX_CONVAR = 'gphone_hodlr_trade_max';
const DEFAULT_TRADE_MAX = 50_000;

/**
 * The ceiling on what one buy or sell may move, in money rather than in coins — a coin cap
 * would mean something different at 50 than at 5000. Read per call, the way `Bank.ts` reads
 * `gphone_bank_transfer_max`, and deliberately the same default: a Hodlr trade and a bank
 * send are the same kind of hole in an economy, and until MICA-130 only one of them was
 * bounded. `requirePositiveInt` accepts any positive integer, so the effective cap on a buy
 * was the whole bank balance and on a sell the whole holding — one call, one position.
 *
 * Per trade, not per session: the rate limiter bounds how many calls a player makes, this
 * bounds what one of them can be worth.
 */
const tradeMax = (): number => {
  const raw = Number.parseInt(GetConvar(TRADE_MAX_CONVAR, String(DEFAULT_TRADE_MAX)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRADE_MAX;
};

/**
 * Trades are refused while the market has not yet checked its price against storage.
 * `HodlrMarket.isMarketReady` carries the reasoning; the short version is that an unrestored
 * price is the opening constant, and settling money against it is the MICA-130 exploit.
 */
const MARKET_CLOSED = { ok: false, reason: 'market_unavailable' } as const;

/** This player's holding row, creating an empty one on first contact. */
const findOrCreateHolding = async (citizenid: string): Promise<HodlrHolding> => {
  const [existing] = await repo.findAll({ citizenid } as Partial<HodlrHolding>);
  if (existing) return existing;

  const id = await repo.create({ citizenid, quantity: 0 });
  const now = new Date().toISOString();
  return { id, citizenid, quantity: 0, status: 'active', created_at: now, updated_at: now };
};

/**
 * Neither read settles money, so a closed market is not a vulnerability here the way it is
 * on `buy`/`sell`. It is still wrong to answer with a number: while the market is closed
 * `getCurrentPrice()` is `STARTING_PRICE` — the constant MICA-130 was built on — and
 * quoting it means the UI states a price with total confidence that the server will refuse
 * every trade at, and any add-on reading `price` gets the same. So the quote is withheld and
 * the state is named instead, and the caller decides what to say.
 *
 * The history is *not* withheld: it comes from storage rather than from the unrestored
 * module state, so the chart is correct even while the market is closed.
 */
const withoutAQuote = { ready: false as const, current: 0 };

app.registerEvent('portfolio', async (source, cbId, data, citizenid) => {
  const holding = await findOrCreateHolding(citizenid);
  // The holding itself is real and disclosed either way; only its valuation is unavailable.
  if (!isMarketReady()) {
    return { ready: false, quantity: holding.quantity, currentPrice: 0, currentValue: 0 };
  }

  const currentPrice = getCurrentPrice();
  return {
    ready: true,
    quantity: holding.quantity,
    currentPrice,
    currentValue: holding.quantity * currentPrice
  };
});

app.registerEvent('price', async () => {
  const history = await getPriceHistory();
  if (!isMarketReady()) return { ...withoutAQuote, history };
  return { ready: true, current: getCurrentPrice(), history };
});

app.registerEvent('buy', async (source, cbId, data, citizenid, player) => {
  if (!isMarketReady()) return MARKET_CLOSED;

  const quantity = requirePositiveInt(fields(data).quantity, 'quantity');
  const price = getCurrentPrice();
  const cost = price * quantity;

  // Before the holding is touched, so a refused trade does not create a row for a player
  // who has never held a coin.
  if (cost > tradeMax()) {
    return { ok: false, reason: 'exceeds_limit' };
  }

  // Ensures the row exists before the atomic increment below — findOrCreateHolding
  // does not itself need to be race-free, since the increment that follows is.
  const holding = await findOrCreateHolding(citizenid);

  if (player.getMoney('bank') < cost) {
    return { ok: false, reason: 'insufficient_funds' };
  }
  if (!player.removeMoney('bank', cost)) {
    return { ok: false, reason: 'debit_failed' };
  }

  // Atomic relative increment rather than read-modify-write off `holding.quantity` —
  // two concurrent buys reading the same stale quantity would otherwise let one
  // overwrite the other's credit (a lost update, not just a double-spend).
  await Database.update('UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [
    quantity,
    holding.id
  ]);

  return { ok: true, quantity: holding.quantity + quantity, price, cost };
});

app.registerEvent('sell', async (source, cbId, data, citizenid, player) => {
  if (!isMarketReady()) return MARKET_CLOSED;

  const quantity = requirePositiveInt(fields(data).quantity, 'quantity');
  // Quoted once, above the decrement, because the cap has to be checked before any coin
  // moves — and settling at the price the request was priced against is the fairer of the
  // two readings anyway.
  const price = getCurrentPrice();
  const proceeds = price * quantity;

  if (proceeds > tradeMax()) {
    return { ok: false, reason: 'exceeds_limit' };
  }

  const holding = await findOrCreateHolding(citizenid);

  // Atomic conditional decrement: the `quantity >= ?` guard is re-checked by the
  // database at write time, not just by the read above, so two concurrent sells
  // cannot both pass the check and jointly overdraw the same holding (TOCTOU).
  // The bank credit only happens once this decrement is confirmed to have applied.
  const decremented = await Database.update(
    'UPDATE `gphone_hodlr` SET `quantity` = `quantity` - ? WHERE `id` = ? AND `quantity` >= ?',
    [quantity, holding.id, quantity]
  );
  if (!decremented) {
    return { ok: false, reason: 'insufficient_holdings' };
  }

  if (!player.addMoney('bank', proceeds)) {
    // The decrement already committed — refund the coins rather than leave the
    // player short with nothing to show for it.
    await Database.update('UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [
      quantity,
      holding.id
    ]);
    return { ok: false, reason: 'credit_failed' };
  }

  return { ok: true, quantity: holding.quantity - quantity, price, proceeds };
});
