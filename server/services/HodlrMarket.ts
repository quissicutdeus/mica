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
 */

const STARTING_PRICE = 500;
const FLOOR = 50;
const CEIL = 5000;
const TICK_MS = 30_000;
/** Up to +/-3% of the current price per tick. */
const MAX_STEP_PCT = 0.03;
const PRICE_HISTORY_TABLE = 'gphone_hodlr_price_history';
/** How far back a chart request reads. Storage keeps more — see HISTORY_RETENTION_DAYS. */
const CHART_WINDOW_HOURS = 24;
/** How long a snapshot row survives before the pruning sweep removes it. */
const HISTORY_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let currentPrice = STARTING_PRICE;

const clamp = (value: number): number => Math.max(FLOOR, Math.min(CEIL, value));

const recordSnapshot = async (price: number): Promise<void> => {
  try {
    await Database.insert(`INSERT INTO \`${PRICE_HISTORY_TABLE}\` (\`price\`) VALUES (?)`, [price]);
  } catch (e) {
    console.error('[gphone] failed to record hodlr price snapshot', e);
  }
};

/** One tick: nudge the price by a bounded random step and clamp it. */
const tickMarket = (): void => {
  const stepPct = (Math.random() * 2 - 1) * MAX_STEP_PCT;
  const next = clamp(Math.round(currentPrice * (1 + stepPct)));
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

/** Test seams: deterministic tick/prune instead of waiting on wall clock or timers. */
export const __tickMarket = tickMarket;
export const __pruneHistory = pruneHistory;
export const __resetMarketState = (): void => {
  currentPrice = STARTING_PRICE;
};

/** What the server believes the coin is worth right now. */
export const getCurrentPrice = (): number => currentPrice;

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
