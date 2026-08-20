import { defineService } from '../lib/defineService';
import type { HodlrHolding } from '@shared/types';
import { fields, requirePositiveInt } from '../lib/payload';
import { getCurrentPrice, getPriceHistory } from './HodlrMarket';
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

/** This player's holding row, creating an empty one on first contact. */
const findOrCreateHolding = async (citizenid: string): Promise<HodlrHolding> => {
  const [existing] = await repo.findAll({ citizenid } as Partial<HodlrHolding>);
  if (existing) return existing;

  const id = await repo.create({ citizenid, quantity: 0 });
  const now = new Date().toISOString();
  return { id, citizenid, quantity: 0, status: 'active', created_at: now, updated_at: now };
};

app.registerEvent('portfolio', async (source, cbId, data, citizenid) => {
  const holding = await findOrCreateHolding(citizenid);
  const currentPrice = getCurrentPrice();
  return {
    quantity: holding.quantity,
    currentPrice,
    currentValue: holding.quantity * currentPrice
  };
});

app.registerEvent('price', async () => {
  const history = await getPriceHistory();
  return { current: getCurrentPrice(), history };
});

app.registerEvent('buy', async (source, cbId, data, citizenid, player) => {
  const quantity = requirePositiveInt(fields(data).quantity, 'quantity');
  const price = getCurrentPrice();
  const cost = price * quantity;

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
  const quantity = requirePositiveInt(fields(data).quantity, 'quantity');
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

  const price = getCurrentPrice();
  const proceeds = price * quantity;

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
