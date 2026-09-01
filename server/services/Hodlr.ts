// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import type { HodlrHolding } from '@gphone/shared/types';
import { defineContract } from '@gphone/shared/contract';
import { s } from '@gphone/shared/schema';
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

/**
 * Hodlr's contract, declared here rather than in `shared/contracts/`.
 *
 * Hodlr is `core: false`, and `shared/` is core — `sdk/coreBoundary.test.ts` refuses core any
 * mention of an app the Store installs. So an add-on declares its contract in its own resource,
 * next to the `defineService` call it belongs to, which is exactly what an external one writes.
 */
export const hodlrContract = defineContract({
  id: 'hodlr',
  actions: {
    /** The caller's own holding and what it is worth. The citizenid is the whole predicate. */
    portfolio: { input: s.none() },
    /** The live price and its history. A property of the market, identical for every caller. */
    price: { input: s.none() },
    /**
     * A whole number of coins, and the ceiling is `int(11)`'s.
     *
     * `requirePositiveInt` refused a fraction and a negative and said nothing about the top,
     * so `Number.MAX_SAFE_INTEGER` reached the arithmetic: `price * quantity` overflows into a
     * float long before MySQL is asked to hold it, and the per-trade cap it is then compared
     * against is checked in that same broken currency.
     */
    buy: { input: s.object({ quantity: s.int({ min: 1, max: 2147483647 }) }) },
    sell: { input: s.object({ quantity: s.int({ min: 1, max: 2147483647 }) }) }
  }
});

export const hodlr = defineService<HodlrHolding, typeof hodlrContract>({
  contract: hodlrContract,
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

const SPREAD_CONVAR = 'gphone_hodlr_spread_pct';
/**
 * The mock UI shipped against before this landed (`web/src/nui/mocks/data.ts`) picked 2%
 * "only so the two numbers actually differ" and left the real width to this file. 2% is
 * kept as the real default too: small enough that a single trade is not a punishing fee,
 * large enough that round-tripping buy-then-sell at the same tick is a guaranteed loss
 * rather than a coin flip against the walk's own noise (`MAX_STEP_PCT` in
 * `HodlrMarket.ts` is 3% *per tick*, so a spread much narrower than that would be inside
 * the walk's own jitter and would not reliably discourage rapid round-tripping — the
 * self-limiting property MICA-147/MICA-149 are relying on instead of a cooldown).
 */
const DEFAULT_SPREAD_PCT = 2;

/**
 * The bid-ask spread, in percent of the mid/reference price — an operator-facing knob,
 * read per call the same way `tradeMax()` reads `gphone_hodlr_trade_max`.
 *
 * Unlike `tradeMax`, `0` is accepted rather than falling back to the default: a spread of
 * zero is a real, meaningful choice (an operator who wants Hodlr to behave like the old
 * single-price coin), where a trade max of zero would make trading impossible outright and
 * is almost certainly a misconfiguration. Only a negative or non-finite value is rejected.
 */
const spreadPct = (): number => {
  const raw = Number.parseFloat(GetConvar(SPREAD_CONVAR, String(DEFAULT_SPREAD_PCT)));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SPREAD_PCT;
};

/**
 * The two quotes a spread turns one mid price into, split evenly above and below it —
 * "quote buy slightly above mid, sell slightly below" is the ticket's own reading, and an
 * even split is the plain one: neither side of a trade is treated as the "real" price with
 * the other side discounted from it.
 *
 * **Rounding is asymmetric on purpose, and always against the trader.** `Math.ceil` on the
 * buy quote and `Math.floor` on the sell quote means a fractional cent is never handed back
 * to the player who triggered it — the same direction real bid-ask spreads round in, and
 * the same lesson MICA-130 already paid for once (a boundary that rounds *toward* the
 * player, even by a fraction, is a free option the first exploit finds). Plain
 * `Math.round` would occasionally round a fraction the trader's way, which is a smaller
 * version of exactly that mistake. `HodlrMarket.test.ts`-style boundary coverage lives in
 * this file's own test for the same reason: the two directions have to be pinned, not
 * merely "close enough" to nearest.
 *
 * The sell quote is additionally floored at 0 — meaningful only at an operator-configured
 * spread wide enough to drive it negative (nothing in the ordinary FLOOR=50/CEIL=5000 band
 * `HodlrMarket.ts` walks within does), and paying a player a negative amount is not an
 * outcome to let arithmetic produce by accident.
 */
export const quoteSpread = (mid: number, pct: number): { buy: number; sell: number } => {
  const halfFraction = pct / 100 / 2;
  return {
    buy: Math.ceil(mid * (1 + halfFraction)),
    sell: Math.max(0, Math.floor(mid * (1 - halfFraction)))
  };
};

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
 * The row's quantity as it stands right now, for the value echoed back after a write that
 * moved it with an atomic relative `UPDATE` (MICA-145). A pre-write read plus the delta
 * this handler applied is correct only when no other trade landed between that read and the
 * write committing — true most of the time, but not under two interleaved trades on the same
 * holding, which is exactly what the atomic update exists to make safe. `fallback` is the
 * pre-write-computed value, used only if the row has somehow vanished by the time this reads
 * it again (it never should — a holding row outlives the trade that touches it) so a caller
 * still gets a number rather than a thrown error after money has already moved.
 */
const currentQuantityOf = async (id: number, fallback: number): Promise<number> => {
  const quantity = await Database.scalar<number | null>(
    'SELECT `quantity` FROM `gphone_hodlr` WHERE `id` = ?',
    [id]
  );
  return quantity ?? fallback;
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
  const current = getCurrentPrice();
  const { buy: buyPrice, sell: sellPrice } = quoteSpread(current, spreadPct());
  return { ready: true, current, buyPrice, sellPrice, history };
});

app.registerEvent('buy', async (source, cbId, data, citizenid, player) => {
  if (!isMarketReady()) return MARKET_CLOSED;

  const { quantity } = data;
  // Quoted once, above the debit, for the same reason `sell` already documents at its own
  // call: the cap has to be checked before any money moves, and settling at the price the
  // request was priced against is the fairer of the two readings. `quoteSpread` is a pure
  // function of `getCurrentPrice()` and `spreadPct()` — no `await` inside it — so this is
  // still one synchronous read, not a second round trip that could see a different price.
  const price = quoteSpread(getCurrentPrice(), spreadPct()).buy;
  const cost = price * quantity;

  // Before the holding is touched, so a refused trade does not create a row for a player
  // who has never held a coin.
  if (cost > tradeMax()) {
    return { ok: false, reason: 'exceeds_limit' };
  }

  // Ensures the row exists before the atomic increment below — findOrCreateHolding
  // does not itself need to be race-free, since the increment that follows is.
  const holding = await findOrCreateHolding(citizenid);

  // Not a bare `<`: a balance the bridge could not determine comes back as `-Infinity`, and
  // anything that is not a number at all would compare as affordable. See `Payments.transfer`.
  //
  // **This check and the debit below must never have an `await` between them (MICA-134).**
  // Same invariant `Payments.transfer` documents at its own top, for the same reason: no SQL
  // predicate makes this atomic, only staying one synchronous span does, on a single-threaded
  // server. `findOrCreateHolding` above is awaited *before* this span starts, which is fine —
  // the race this closes is between reading the balance and debiting it, not before either
  // has happened. `server/__tests__/moneyAtomicity.test.ts` asserts this mechanically.
  const balance = player.getMoney('bank');
  if (!Number.isFinite(balance) || balance < cost) {
    return { ok: false, reason: 'insufficient_funds' };
  }
  if (!player.removeMoney('bank', cost)) {
    return { ok: false, reason: 'debit_failed' };
  }

  // Atomic relative increment rather than read-modify-write off `holding.quantity` —
  // two concurrent buys reading the same stale quantity would otherwise let one
  // overwrite the other's credit (a lost update, not just a double-spend).
  //
  // The money is already gone by the time this runs, so its outcome is not optional
  // (MICA-132). This ignored the returned boolean and carried no `try`/`catch`: a throw
  // here — or a row that had vanished — left the debit committed and no coins credited, and
  // the player was told the trade failed while being charged for it. `sell` has handled the
  // mirror case since it was written, refunding the coins when the bank credit fails; this
  // is the same care on the half that was missing it. It burns the player's own money rather
  // than being attacker-profitable, which is exactly why it would have arrived as a bug
  // report rather than as an exploit.
  let credited = false;
  try {
    credited = await Database.update(
      'UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?',
      [quantity, holding.id]
    );
  } catch (error) {
    console.error(`[hodlr] buy could not credit ${citizenid}:`, error);
  }

  if (!credited) {
    // Put the money back. If even that fails there is nothing further this handler can do,
    // so it is logged loudly rather than swallowed — a server owner reading this line is
    // the only remaining path to making the player whole.
    if (!player.addMoney('bank', cost)) {
      console.error(
        `[hodlr] buy debited ${cost} from ${citizenid} and could neither credit coins nor refund.`
      );
    }
    return { ok: false, reason: 'credit_failed' };
  }

  // Re-read rather than echo `holding.quantity + quantity`: the increment above is atomic
  // in SQL specifically so two concurrent trades can't clobber each other, but that also
  // means this handler's own pre-write read is stale the moment a concurrent trade commits
  // between it and here. The stored value is always correct; only the number handed back to
  // this caller could otherwise disagree with it until the next portfolio read. Low
  // severity — no money or coins are at risk, nothing is corrupted, it's a display value.
  const currentQuantity = await currentQuantityOf(holding.id, holding.quantity + quantity);

  return { ok: true, quantity: currentQuantity, price, cost };
});

app.registerEvent('sell', async (source, cbId, data, citizenid, player) => {
  if (!isMarketReady()) return MARKET_CLOSED;

  const { quantity } = data;
  // Quoted once, above the decrement, because the cap has to be checked before any coin
  // moves — and settling at the price the request was priced against is the fairer of the
  // two readings anyway. `quoteSpread` is pure and synchronous, same reasoning as `buy`.
  const price = quoteSpread(getCurrentPrice(), spreadPct()).sell;
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

  // `sell` has no `getMoney`/`removeMoney` pair to keep un-yielded (MICA-134): its
  // "balance check" is the SQL-level `quantity >= ?` guard above, not a JS read-then-write,
  // so there is nothing here for a stray `await` to race against. This is the only money
  // call in the function, and a single call has no span to be atomic with.
  if (!player.addMoney('bank', proceeds)) {
    // The decrement already committed — refund the coins rather than leave the
    // player short with nothing to show for it.
    await Database.update('UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [
      quantity,
      holding.id
    ]);
    return { ok: false, reason: 'credit_failed' };
  }

  // Same reasoning as `buy` above: the decrement is atomic in SQL precisely so two
  // concurrent sells can't both pass the `quantity >= ?` guard, which means this handler's
  // pre-write read can be stale by the time this line runs. Re-read rather than echo
  // `holding.quantity - quantity`.
  const currentQuantity = await currentQuantityOf(holding.id, holding.quantity - quantity);

  return { ok: true, quantity: currentQuantity, price, proceeds };
});
