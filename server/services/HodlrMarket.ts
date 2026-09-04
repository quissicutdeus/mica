// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../lib/Database';
import type { PricePoint } from '@mica/shared/types';

/**
 * The single global coin price, ticked by the server and persisted for the chart.
 *
 * Modeled on Battery.ts: module-scope state advanced by a guarded `setInterval`, with
 * `__tick*`/`__reset*` test seams instead of waiting on the wall clock. Unlike Battery,
 * there is exactly one price shared by every player rather than one value per source, so
 * there is no per-connection map here.
 *
 * `mica_hodlr_price_history` is declared as a child table on `Hodlr.ts`'s
 * `defineService` (see that file), not here — DDL generation only scans `defineService`
 * declarations, and there is no per-player owner for a global price to declare one
 * against. This module still owns every read/write against that table, the same way
 * `Marketplace.ts` owns `mica_marketplace_attachments` despite declaring it on the
 * `marketplace` service.
 *
 * ## The price is persistent state (MICA-130)
 *
 * It used to be module state and nothing else: `currentPrice` opened at `STARTING_PRICE`
 * on every resource start while `mica_hodlr.quantity` — the holdings the price values —
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
const PRICE_HISTORY_TABLE = 'mica_hodlr_price_history';
/**
 * Read, never written, by this module: it is `Hodlr.ts`'s table. What it answers here is
 * whether anybody holds a coin, which is what separates a fresh install from a lost history
 * — see `restorePrice`.
 */
const HOLDINGS_TABLE = 'mica_hodlr';
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
/**
 * How many ticks a restore may stay in flight before the next tick abandons it and starts
 * another.
 *
 * `restoreInFlight` stops two overlapping reads. On its own it also means a read that never
 * *settles* latches the market closed for the life of the resource: `finally` never runs,
 * the flag stays `true`, and `tickMarket`'s `!restored` guard returns immediately every 30
 * seconds forever — every trade refused, no snapshots written, the chart flat, recoverable
 * only by restarting mica.
 *
 * That is not hypothetical. `restart oxmysql` — or an oxmysql crash — while `scalar_async`
 * is outstanding drops the export callback, so the promise neither resolves nor rejects. A
 * *rejected* read was always fine and always retried; an abandoned one is what this bounds.
 * Two ticks is a minute of closed market against a read that normally lands in milliseconds.
 *
 * **Not superseded by `Database.ts`'s general MICA-160 timeout, even though both land on
 * a minute.** That timeout makes `Database.scalar` itself reject rather than hang, which
 * would on its own be enough to clear `restoreInFlight` through the ordinary `catch`/`finally`
 * below — but it cannot cancel the real `oxmysql` call underneath it, only stop this module
 * from waiting on it. If that real call later answers anyway, `restoreGeneration` below is
 * what stops the stale answer from overwriting a market that has since been restored again by
 * a fresh attempt; a bounded promise is not the same guarantee as an ignored one. This module's
 * tests also mock `Database` wholesale (as every server suite does, to keep a real connection
 * out of `pnpm test:unit:server`), so they cannot exercise the general timeout at all — the
 * "never settles" cases below stay meaningful only because this module still owns its own
 * abandon-and-retry.
 */
const MAX_RESTORE_TICKS = 2;
let restoreTicksWaited = 0;
/**
 * Bumped whenever an attempt is abandoned, so a read that settles long after the tick loop
 * gave up on it cannot write its stale answer over a market that has since reopened and
 * moved on.
 */
let restoreGeneration = 0;

/** Hard bounds. Used for a value read back from storage, which has no direction to reflect. */
const clamp = (value: number): number => Math.max(FLOOR, Math.min(CEIL, value));

/**
 * Keep a step inside [FLOOR, CEIL] by reflecting off the boundary rather than flattening
 * against it.
 *
 * Clamping made the floor a free option (MICA-130): at 50 a down-step rounded back to 50,
 * `tickMarket`'s `next === currentPrice` guard made it a no-op, and a holder sitting there
 * had no downside at all while every up-step still paid. Reflection keeps the size of the
 * move and only turns it around, so a step near the boundary is recorded as a real move in
 * the direction it was turned rather than being swallowed. The clamp is kept as a final
 * backstop for a value that arrives outside the band some other way.
 *
 * **The boundary itself is still one-way, and reflection makes it more so, not less.** At
 * exactly `FLOOR` every draw resolves to an up-move or a rounding no-op — measured over
 * 200,000 steps at 50: 133,033 up, 66,967 no-op, 0 down. Under the old clamp a down-step
 * became a no-op; under reflection it becomes a real, recorded, paid up-move, so a
 * floor-sitter is strictly better off after this fix than before it. No choice of rule
 * removes that: any hard bound is one-way at the bound, and removing the bound is worse.
 *
 * What makes it unexploitable is the *distance* to the boundary, not the rule at it.
 * `REVERSION_PER_TICK` pulls up by 0.46% per tick at 50 — over 200 simulated weeks of
 * ticking the price never went below 145. So the floor is defended by never being reached.
 * Lowering `REVERSION_PER_TICK`, raising `MAX_STEP_PCT`, or moving `FLOOR` toward the band
 * re-arms this; `HodlrMarket.test.ts` pins both halves — that the boundary is one-way, and
 * that the constants keep the walk clear of it — so such a change fails loudly.
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
    console.error('[mica] failed to record hodlr price snapshot', e);
  }
};

/**
 * Whether anybody on this server holds a coin.
 *
 * Only asked when the price history reads empty, and only to tell a fresh install apart
 * from a lost one. `quantity > 0` rather than "a row exists": a player who bought and sold
 * everything leaves a zero row behind, and that should not wedge the market closed forever.
 */
const hasHoldings = async (): Promise<boolean> => {
  const held = await Database.scalar<number | null>(
    `SELECT 1 FROM \`${HOLDINGS_TABLE}\` WHERE \`quantity\` > 0 LIMIT 1`
  );
  return Boolean(held);
};

/**
 * Reopen the market at the price it closed on.
 *
 * The newest snapshot is the price the last tick moved to, because a snapshot is written
 * exactly when the price moves — so "latest row" and "what the coin was worth when the
 * resource stopped" are the same thing, and no new column or write cadence is needed. Read
 * by `id` rather than `recorded_at`, whose one-second resolution can tie.
 *
 * A stored value that is not a sane price is clamped rather than trusted. A failed read
 * leaves the market closed and unrestored, which the next tick retries — a database that is
 * briefly down must not be able to open the market at 500.
 *
 * **No usable price is only a fresh install if nobody holds a coin.** An empty history and
 * an empty `mica_hodlr` is a server that has never traded, and it opens at
 * `STARTING_PRICE`. An empty history *while holdings exist* is a lost history, and opening
 * at `STARTING_PRICE` there re-creates the exact MICA-130 precondition this commit exists
 * to remove: every holding re-valued at the constant in the source, with `quantity`
 * untouched. It is reachable two ways — an operator truncating a table that still reads like
 * a chart cache, and the pruning sweep below — so the market stays closed and says why,
 * rather than quoting a number it cannot stand behind.
 */
const restorePrice = async (): Promise<void> => {
  if (restored || restoreInFlight) return;
  restoreInFlight = true;
  restoreTicksWaited = 0;
  const attempt = restoreGeneration;

  try {
    const stored = await Database.scalar<number | null>(
      `SELECT \`price\` FROM \`${PRICE_HISTORY_TABLE}\` ORDER BY \`id\` DESC LIMIT 1`
    );
    const price = Math.round(Number(stored));
    const usable = Number.isFinite(price) && price > 0;
    const traded = usable ? false : await hasHoldings();

    // Every await is behind us. An attempt the tick loop gave up on must not write its
    // answer over a market that has since been restored and walked away from it.
    if (attempt !== restoreGeneration) return;

    if (traded) {
      console.error(
        `[mica] hodlr has holdings but no price history; market stays closed rather than ` +
          `reopening at ${STARTING_PRICE}. Restore \`${PRICE_HISTORY_TABLE}\` from a backup, ` +
          `or clear \`${HOLDINGS_TABLE}\` if this economy is genuinely being reset.`
      );
      return;
    }

    if (usable) currentPrice = clamp(price);
    restored = true;
    console.log(`[mica] hodlr market open at ${currentPrice}`);
  } catch (e) {
    console.error('[mica] failed to restore the hodlr price; market closed until retried', e);
  } finally {
    if (attempt === restoreGeneration) restoreInFlight = false;
  }
};

/** One tick: nudge the price by a bounded random step, reverting toward the reference. */
const tickMarket = (): void => {
  // A tick before the restore lands would trade off 500 and then snapshot that 500 as the
  // newest row — overwriting the very value being restored. Retrying here rather than on a
  // timer of its own is what heals a start that raced a database still coming up.
  if (!restored) {
    if (restoreInFlight) {
      // A read that never settles, rather than one that failed — see MAX_RESTORE_TICKS.
      if (++restoreTicksWaited < MAX_RESTORE_TICKS) return;
      restoreInFlight = false;
      restoreGeneration++;
      console.error('[mica] hodlr price restore did not settle; abandoning it and reading again');
    }
    void restorePrice();
    return;
  }

  const next = nextPrice(currentPrice);
  if (next === currentPrice) return;

  currentPrice = next;
  void recordSnapshot(currentPrice);
};

/**
 * Drop snapshots past the retention window — except the newest row, always.
 *
 * That row is not a chart point, it is the price: `restorePrice` reads exactly it to reopen
 * the market. A server that has been down longer than `HISTORY_RETENTION_DAYS` has *every*
 * row past the window, so the first hourly sweep after it comes up would delete the price
 * along with the history, and hand the next restore an empty table — MICA-130's own
 * precondition, reached through MICA-130's own retry path.
 *
 * Two statements rather than one self-referencing `DELETE`, because MySQL refuses a
 * subquery against the table being deleted from (error 1093) and the derived-table dodge
 * around it is harder to read than a second indexed lookup once an hour. An empty table
 * yields no id and `0` matches no row, since AUTO_INCREMENT starts at 1.
 */
const pruneHistory = async (): Promise<void> => {
  try {
    const newest = await Database.scalar<number | null>(
      `SELECT \`id\` FROM \`${PRICE_HISTORY_TABLE}\` ORDER BY \`id\` DESC LIMIT 1`
    );
    await Database.update(
      `DELETE FROM \`${PRICE_HISTORY_TABLE}\`
       WHERE \`recorded_at\` < NOW() - INTERVAL ? DAY AND \`id\` <> ?`,
      [HISTORY_RETENTION_DAYS, Number(newest) || 0]
    );
  } catch (e) {
    console.error('[mica] failed to prune hodlr price history', e);
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
  restoreTicksWaited = 0;
  restoreGeneration = 0;
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
    console.error('[mica] failed to read hodlr price history', e);
    return [];
  }
};
