// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CasinoBet } from '@mica/shared/types';

/**
 * The casino's rules as plain functions (MICA-82): no store, no SDK, nothing that needs a DOM.
 *
 * Everything here is a **mirror**, never the authority. The server draws the number, decides
 * the crash point, checks the stake against the player's balance and pays out; a modified
 * client can send any `spin` it likes (AGENTS.md §2.9). The mirror exists so the board can
 * refuse a bet before the round trip, and so the player sees what a bet would return.
 */

/** One bet on the board, exactly as `spin` takes it. */
export type Bet = CasinoBet;
export type BetKind = CasinoBet['kind'];

/** The most bets one spin may carry (`MAX_BETS` in `server/services/Casino.ts`). */
export const MAX_BETS = 20;

export interface CasinoConfig {
  bet_min: number;
  bet_max: number;
  crash_edge_pct: number;
  wheel: 'european';
}

export type PocketColor = 'red' | 'black' | 'green';

/** The European wheel's red pockets. Every other number but 0 is black. */
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const colorOf = (n: number): PocketColor =>
  n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';

/** What one unit staked wins on top of itself: 35:1, 2:1, or evens. */
export const ODDS: Record<BetKind, number> = {
  straight: 35,
  dozen: 2,
  column: 2,
  red: 1,
  black: 1,
  odd: 1,
  even: 1,
  low: 1,
  high: 1
};

const VALUE_RANGE: Partial<Record<BetKind, [number, number]>> = {
  straight: [0, 36],
  dozen: [1, 3],
  column: [1, 3]
};

/** Whether one bet wins on `n`. Zero loses every outside bet, as on a real table. */
export const wins = (bet: Pick<Bet, 'kind' | 'value'>, n: number): boolean => {
  if (bet.kind === 'straight') return bet.value === n;
  if (n === 0) return false;
  switch (bet.kind) {
    case 'red':
    case 'black':
      return colorOf(n) === bet.kind;
    case 'odd':
      return n % 2 === 1;
    case 'even':
      return n % 2 === 0;
    case 'low':
      return n <= 18;
    case 'high':
      return n >= 19;
    case 'dozen':
      return Math.ceil(n / 12) === bet.value;
    case 'column':
      return ((n - 1) % 3) + 1 === bet.value;
  }
};

/** What a bet hands back when it wins: the stake plus its odds. */
export const returnOf = (bet: Pick<Bet, 'kind' | 'amount'>): number =>
  bet.amount * (ODDS[bet.kind] + 1);

export const stakeOf = (bets: readonly Bet[]): number =>
  bets.reduce((total, bet) => total + bet.amount, 0);

/** Everything a spin hands back on `n` — stakes of winning bets included, losing ones gone. */
export const payoutFor = (bets: readonly Bet[], n: number): number =>
  bets.reduce((total, bet) => total + (wins(bet, n) ? returnOf(bet) : 0), 0);

/** The best a board can do on one number: the preview the spin button carries. */
export const bestPayout = (bets: readonly Bet[]): number => {
  let best = 0;
  for (let n = 0; n <= 36; n++) best = Math.max(best, payoutFor(bets, n));
  return best;
};

/**
 * Why a board would be refused, as the slug the server answers with, or `null` when the
 * server ought to take it. The balance is the server's to check; this cannot see it.
 */
export type BetProblem = 'no_bets' | 'too_many_bets' | 'invalid_bet' | 'below_min' | 'above_max';

export const betProblem = (bets: readonly Bet[], config: CasinoConfig): BetProblem | null => {
  if (bets.length === 0) return 'no_bets';
  if (bets.length > MAX_BETS) return 'too_many_bets';
  for (const bet of bets) {
    if (!(bet.kind in ODDS)) return 'invalid_bet';
    const range = VALUE_RANGE[bet.kind];
    if (range) {
      const v = bet.value;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < range[0] || v > range[1]) {
        return 'invalid_bet';
      }
    } else if (bet.value !== undefined) {
      return 'invalid_bet';
    }
    if (!Number.isInteger(bet.amount) || bet.amount <= 0) return 'invalid_bet';
    if (bet.amount < config.bet_min) return 'below_min';
  }
  if (stakeOf(bets) > config.bet_max) return 'above_max';
  return null;
};

/** One spot on the board, identified the same way however many chips sit on it. */
export const spotKey = (bet: Pick<Bet, 'kind' | 'value'>): string =>
  bet.value === undefined ? bet.kind : `${bet.kind}-${bet.value}`;

/**
 * Put one chip on a spot: stacked onto a bet already there, or a new bet. Refused — the same
 * array back — when it would take the board's total past `bet_max`, or open a twenty-first
 * spot.
 */
export const addChip = (
  bets: readonly Bet[],
  spot: Pick<Bet, 'kind' | 'value'>,
  chip: number,
  config: CasinoConfig
): readonly Bet[] => {
  if (stakeOf(bets) + chip > config.bet_max) return bets;
  const key = spotKey(spot);
  const existing = bets.find((b) => spotKey(b) === key);
  if (existing) {
    return bets.map((b) => (b === existing ? { ...b, amount: b.amount + chip } : b));
  }
  if (bets.length >= MAX_BETS) return bets;
  const bet: Bet = { kind: spot.kind, amount: chip };
  if (spot.value !== undefined) bet.value = spot.value;
  return [...bets, bet];
};

const DENOMINATIONS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];

/**
 * The chips on offer: the usual denominations inside `[bet_min, bet_max]`, with the minimum
 * itself always first so the smallest legal bet is one tap. At most six, smallest first —
 * the row has to fit the phone.
 */
export const chipValues = (config: Pick<CasinoConfig, 'bet_min' | 'bet_max'>): number[] => {
  const { bet_min: min, bet_max: max } = config;
  if (!(min > 0) || max < min) return [];
  const inside = DENOMINATIONS.filter((d) => d > min && d <= max);
  const values = [min, ...inside];
  if (values.length <= 6) return values;
  // Keep the minimum and spread the rest evenly up to the largest.
  const rest = values.slice(1);
  const picked = [min];
  for (let i = 1; i <= 5; i++) picked.push(rest[Math.round((i * (rest.length - 1)) / 5)]);
  return [...new Set(picked)];
};

// ── Crash ──────────────────────────────────────────────────────────────────────────

/** The curve doubles every ten seconds: m(t) = 2^(t / 10s). */
export const CRASH_DOUBLING_MS = 10_000;

/** The multiplier `elapsedMs` into a round, as an integer ×100 (1.00× is 100), floored. */
export const multiplierAt = (elapsedMs: number): number =>
  Math.floor(100 * 2 ** (Math.max(0, elapsedMs) / CRASH_DOUBLING_MS));

/** How long the curve takes to reach a multiplier ×100: the inverse of `multiplierAt`. */
export const elapsedFor = (multiplier: number): number =>
  multiplier <= 100 ? 0 : CRASH_DOUBLING_MS * Math.log2(multiplier / 100);

/** What cashing out `stake` at a multiplier ×100 pays, floored to a whole dollar. */
export const crashPayout = (stake: number, multiplier: number): number =>
  Math.floor((stake * multiplier) / 100);

/** `250` → `"2.50×"`. */
export const formatMultiplier = (multiplier: number): string => `${(multiplier / 100).toFixed(2)}×`;

export const stakeProblem = (
  stake: number,
  config: Pick<CasinoConfig, 'bet_min' | 'bet_max'>
): BetProblem | null => {
  if (!Number.isInteger(stake) || stake <= 0) return 'invalid_bet';
  if (stake < config.bet_min) return 'below_min';
  if (stake > config.bet_max) return 'above_max';
  return null;
};
