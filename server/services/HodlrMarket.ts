import { Database } from '../lib/Database';
import type { PricePoint } from '@shared/types';

/**
 * The single global coin price, ticked by the server and persisted for the chart.
 *
 * Modeled on Battery.ts: module-scope state advanced by a guarded `setInterval`, with
 * `__tick*`/`__reset*` test seams instead of waiting on the wall clock. Unlike Battery,
 * there is exactly one price shared by every player rather than one value per source, so
 * there is no per-connection map here.
 *
 * `gphone_hodlr_price_history` is declared as a child table on `Hodlr.ts`'s
 * `defineService` (see that file), not here — DDL generation only scans `defineService`
 * declarations, and there is no per-player owner for a global price to declare one
 * against. This module still owns every read/write against that table, the same way
 * `Marketplace.ts` owns `gphone_marketplace_attachments` despite declaring it on the
 * `marketplace` service.
 *
 * ## The price is persistent state (MICA-130)
 *
 * It used to be module state and nothing else: `currentPrice` opened at `STARTING_PRICE`
 * on every resource start while `gphone_hodlr.quantity` — the holdings the price values —
 * was a real column that came straight back. So a restart re-valued every holding at 500,
 * a constant anyone can read in the AGPL source, and buying below it was a risk-free bet
 * on the next restart. The snapshot table already held the answer and was only ever read
 * to draw a chart; `restorePrice` below is what reads it back.
 */

const STARTING_PRICE = 500;
/**
 * What the walk is pulled back toward. The same number as the opening price: the coin has
 * one reference value, and a fresh install opens at it.
 */
const REFERENCE_PRICE = STARTING_PRICE;
const FLOOR = 50;
const CEIL = 5000;
const TICK_MS = 30_000;
/** Up to +/-3% of the current price per tick. */
const MAX_STEP_PCT = 0.03;
/**
 * How hard each tick pulls the price back toward `REFERENCE_PRICE`, as a fraction of the
 * log-distance still to cover. 0.002 per 30-second tick is a half-life of roughly three
 * hours, which is slow enough that an hour of trading feels like a market rather than a
 * spring, and fast enough that a week of uptime does not end pinned to a boundary.
 */
const REVERSION_PER_TICK = 0.002;
const PRICE_HISTORY_TABLE = 'gphone_hodlr_price_history';
/** How far back a chart request reads. Storage keeps more — see HISTORY_RETENTION_DAYS. */
const CHART_WINDOW_HOURS = 24;
/** How long a snapshot row survives before the pruning sweep removes it. */
const HISTORY_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let currentPrice = STARTING_PRICE;
/**
 * Whether `currentPrice` is the price this install last traded at, or still the
 * module-scope default nobody has checked against the database yet.
 *
 * Everything that turns the price into money is gated on this. The restore is one indexed
 * read and lands in milliseconds, but "milliseconds at resource start" is exactly the
 * window a restart exploit lives in, and during it the market would quote precisely the
 * constant the exploit was built around. A closed market refuses trades; it does not
 * refuse the chart or the portfolio, which disclose no money.
 */
let restored = false;
let restoreInFlight = false;

/** Hard bounds. Used for a value read back from storage, which has no direction to reflect. */
const clamp = (value: number): number => Math.max(FLOOR, Math.min(CEIL, value));

/**
 * Keep a step inside [FLOOR, CEIL] by reflecting off the boundary rather than flattening
 * against it.
 *
 * Clamping made the floor a free option (MICA-130): at 50 a down-step rounded back to 50,
 * `tickMarket`'s `next === currentPrice` guard made it a no-op, and a holder sitting there
 * had no downside at all while every up-step still paid. Reflection keeps the size of the
 * move and only turns it around, so the boundary is symmetric — a down-step at the floor is
 * a real up-move that is recorded, an up-step at the ceiling is a real down-move — and the
 * price can no longer sit in a state where only one direction registers. The clamp is kept
 * as a final backstop for a value that arrives outside the band some other way.
 */
const bounded = (value: number): number => {
  if (value < FLOOR) return clamp(2 * FLOOR - value);
  if (value > CEIL) return clamp(2 * CEIL - value);
  return value;
};

/**
 * One step of the walk, in log space and mean-reverting.
 *
 * The old step was `price * (1 + U)` for a symmetric `U`, which decays by construction:
 * `E[log(1 + U)] < 0`, so the typical path drifts down however fair each individual step
 * looks, and the coin spent most of its life below the price it opened at. Stepping in log
 * space removes that bias — a -3% move and a +3% move are the same size — and the pull
 * toward `REFERENCE_PRICE` is what keeps a long-running server's coin in a band instead of
 * random-walking into a clamp and staying there.
 */
const nextPrice = (price: number): number => {
  const step = (Math.random() * 2 - 1) * MAX_STEP_PCT;
  const pull = REVERSION_PER_TICK * Math.log(REFERENCE_PRICE / price);
  return bounded(Math.round(price * Math.exp(step + pull)));
};

const recordSnapshot = async (price: number): Promise<void> => {
  try {
    await Database.insert(`INSERT INTO \`${PRICE_HISTORY_TABLE}\` (\`price\`) VALUES (?)`, [price]);
  } catch (e) {
    console.error('[gphone] failed to record hodlr price snapshot', e);
  }
};

/**
 * Reopen the market at the price it closed on.
 *
 * The newest snapshot is the price the last tick moved to, because a snapshot is written
 * exactly when the price moves — so "latest row" and "what the coin was worth when the
 * resource stopped" are the same thing, and no new column or write cadence is needed. Read
 * by `id` rather than `recorded_at`, whose one-second resolution can tie.
 *
 * An empty table is a fresh install and opens at `STARTING_PRICE`; a stored value that is
 * not a sane price is clamped rather than trusted. A failed read leaves the market closed
 * and unrestored, which the next tick retries — a database that is briefly down must not
 * be able to open the market at 500.
 */
const restorePrice = async (): Promise<void> => {
  if (restored || restoreInFlight) return;
  restoreInFlight = true;
  try {
    const stored = await Database.scalar<number | null>(
      `SELECT \`price\` FROM \`${PRICE_HISTORY_TABLE}\` ORDER BY \`id\` DESC LIMIT 1`
    );
    const price = Math.round(Number(stored));
    if (Number.isFinite(price) && price > 0) currentPrice = clamp(price);
    restored = true;
    console.log(`[gphone] hodlr market open at ${currentPrice}`);
  } catch (e) {
    console.error('[gphone] failed to restore the hodlr price; market closed until retried', e);
  } finally {
    restoreInFlight = false;
  }
};

/** One tick: nudge the price by a bounded random step, reverting toward the reference. */
const tickMarket = (): void => {
  // A tick before the restore lands would trade off 500 and then snapshot that 500 as the
  // newest row — overwriting the very value being restored. Retrying here rather than on a
  // timer of its own is what heals a start that raced a database still coming up.
  if (!restored) {
    void restorePrice();
    return;
  }

  const next = nextPrice(currentPrice);
  if (next === currentPrice) return;

  currentPrice = next;
  void recordSnapshot(currentPrice);
};

const pruneHistory = async (): Promise<void> => {
  try {
    await Database.update(
      `DELETE FROM \`${PRICE_HISTORY_TABLE}\` WHERE \`recorded_at\` < NOW() - INTERVAL ? DAY`,
      [HISTORY_RETENTION_DAYS]
    );
  } catch (e) {
    console.error('[gphone] failed to prune hodlr price history', e);
  }
};

if (typeof setInterval === 'function') {
  setInterval(tickMarket, TICK_MS);
  setInterval(pruneHistory, PRUNE_INTERVAL_MS);
}

/**
 * `onResourceStart` rather than module scope, for the reason `Media.ts` gives: module
 * evaluation is the earliest possible moment to ask oxmysql for anything, and a read that
 * ran on import would run inside every server suite that loads this file.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;
  void restorePrice();
});

/** Test seams: deterministic tick/prune/restore instead of waiting on wall clock or timers. */
export const __tickMarket = tickMarket;
export const __pruneHistory = pruneHistory;
export const __restorePrice = restorePrice;
/**
 * Defaults to an open market at the opening price, which is the state every case that is
 * not about the restore means. Pass `{ restored: false }` for a server that has just
 * started, or `{ price }` to place the market at a boundary without walking it there.
 */
export const __resetMarketState = (options: { restored?: boolean; price?: number } = {}): void => {
  currentPrice = options.price ?? STARTING_PRICE;
  restored = options.restored ?? true;
  restoreInFlight = false;
};

/** What the server believes the coin is worth right now. */
export const getCurrentPrice = (): number => currentPrice;

/**
 * Whether the price has been checked against storage yet. Trades are refused until it has —
 * see `restored` above.
 */
export const isMarketReady = (): boolean => restored;

/** Snapshot rows from the last `CHART_WINDOW_HOURS`, oldest first — what a chart draws. */
export const getPriceHistory = async (): Promise<PricePoint[]> => {
  try {
    return await Database.query<PricePoint[]>(
      `SELECT \`price\`, \`recorded_at\` FROM \`${PRICE_HISTORY_TABLE}\`
       WHERE \`recorded_at\` >= NOW() - INTERVAL ? HOUR
       ORDER BY \`recorded_at\` ASC`,
      [CHART_WINDOW_HOURS]
    );
  } catch (e) {
    console.error('[gphone] failed to read hodlr price history', e);
    return [];
  }
};
