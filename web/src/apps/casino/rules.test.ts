// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  addChip,
  bestPayout,
  betProblem,
  chipValues,
  colorOf,
  crashPayout,
  elapsedFor,
  formatMultiplier,
  multiplierAt,
  payoutFor,
  stakeOf,
  stakeProblem,
  wins,
  type Bet,
  type CasinoConfig
} from './rules';

/**
 * The casino's client-side mirror of the server's rules (MICA-82). Nothing here is authority —
 * the server draws and pays — but a mirror that disagrees with the server either refuses a bet
 * the table would take or previews a return the table will not pay, so each rule is pinned.
 */

const CONFIG: CasinoConfig = { bet_min: 10, bet_max: 1000, crash_edge_pct: 3, wheel: 'european' };

describe('the wheel', () => {
  it('paints the European red pockets red, zero green, and the rest black', () => {
    const reds = Array.from({ length: 37 }, (_, n) => n).filter((n) => colorOf(n) === 'red');
    expect(reds).toEqual([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
    expect(colorOf(0)).toBe('green');
    expect(colorOf(2)).toBe('black');
    expect(colorOf(35)).toBe('black');
  });

  it('loses every outside bet on zero, and pays a straight on zero', () => {
    for (const kind of ['red', 'black', 'odd', 'even', 'low', 'high'] as const) {
      expect(wins({ kind }, 0)).toBe(false);
    }
    expect(wins({ kind: 'dozen', value: 1 }, 0)).toBe(false);
    expect(wins({ kind: 'column', value: 1 }, 0)).toBe(false);
    expect(wins({ kind: 'straight', value: 0 }, 0)).toBe(true);
  });

  it('places dozens and columns where the table does', () => {
    expect(wins({ kind: 'dozen', value: 1 }, 12)).toBe(true);
    expect(wins({ kind: 'dozen', value: 2 }, 13)).toBe(true);
    expect(wins({ kind: 'dozen', value: 3 }, 36)).toBe(true);
    expect(wins({ kind: 'column', value: 1 }, 34)).toBe(true);
    expect(wins({ kind: 'column', value: 2 }, 35)).toBe(true);
    expect(wins({ kind: 'column', value: 3 }, 36)).toBe(true);
    expect(wins({ kind: 'column', value: 1 }, 36)).toBe(false);
  });

  it('splits low and high at 18/19', () => {
    expect(wins({ kind: 'low' }, 18)).toBe(true);
    expect(wins({ kind: 'high' }, 18)).toBe(false);
    expect(wins({ kind: 'high' }, 19)).toBe(true);
  });
});

describe('payouts', () => {
  it('returns the stake plus 35:1, 2:1 and evens, and nothing for a loser', () => {
    expect(payoutFor([{ kind: 'straight', value: 17, amount: 10 }], 17)).toBe(360);
    expect(payoutFor([{ kind: 'dozen', value: 2, amount: 10 }], 17)).toBe(30);
    expect(payoutFor([{ kind: 'column', value: 2, amount: 10 }], 17)).toBe(30);
    expect(payoutFor([{ kind: 'black', amount: 10 }], 17)).toBe(20);
    expect(payoutFor([{ kind: 'red', amount: 10 }], 17)).toBe(0);
  });

  it('sums every winning bet on one board', () => {
    const board: Bet[] = [
      { kind: 'straight', value: 17, amount: 10 },
      { kind: 'black', amount: 20 },
      { kind: 'even', amount: 30 }
    ];
    expect(stakeOf(board)).toBe(60);
    expect(payoutFor(board, 17)).toBe(360 + 40);
    expect(payoutFor(board, 0)).toBe(0);
  });

  it('previews the best a board can do on any single number', () => {
    const board: Bet[] = [
      { kind: 'straight', value: 17, amount: 10 },
      { kind: 'red', amount: 20 }
    ];
    // 17 is black, so the straight and the red never land together.
    expect(bestPayout(board)).toBe(360);
    expect(bestPayout([])).toBe(0);
  });
});

describe('the bet validation mirror', () => {
  it('takes a legal board', () => {
    expect(betProblem([{ kind: 'straight', value: 36, amount: 10 }], CONFIG)).toBeNull();
    expect(betProblem([{ kind: 'red', amount: 1000 }], CONFIG)).toBeNull();
  });

  it('refuses an empty board, and one past the twenty-bet cap', () => {
    expect(betProblem([], CONFIG)).toBe('no_bets');
    const many = Array.from({ length: 21 }, (_, n) => ({
      kind: 'straight' as const,
      value: n,
      amount: 10
    }));
    expect(betProblem(many, { ...CONFIG, bet_max: 10_000 })).toBe('too_many_bets');
    expect(betProblem(many.slice(0, 20), { ...CONFIG, bet_max: 10_000 })).toBeNull();
  });

  it('refuses a value off the table, a missing value, or a value on an even-money bet', () => {
    expect(betProblem([{ kind: 'straight', value: 37, amount: 10 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'dozen', value: 0, amount: 10 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'column', value: 4, amount: 10 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'dozen', amount: 10 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'red', value: 1, amount: 10 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'straight', value: 1.5, amount: 10 }], CONFIG)).toBe('invalid_bet');
  });

  it('refuses a fractional or non-positive amount', () => {
    expect(betProblem([{ kind: 'red', amount: 10.5 }], CONFIG)).toBe('invalid_bet');
    expect(betProblem([{ kind: 'red', amount: 0 }], CONFIG)).toBe('invalid_bet');
  });

  it('holds each bet to the minimum and the board to the maximum', () => {
    expect(betProblem([{ kind: 'red', amount: 9 }], CONFIG)).toBe('below_min');
    expect(
      betProblem(
        [
          { kind: 'red', amount: 600 },
          { kind: 'odd', amount: 401 }
        ],
        CONFIG
      )
    ).toBe('above_max');
  });
});

describe('placing chips', () => {
  it('stacks a chip onto the bet already on a spot', () => {
    let board = addChip([], { kind: 'straight', value: 5 }, 10, CONFIG);
    board = addChip(board, { kind: 'straight', value: 5 }, 25, CONFIG);
    board = addChip(board, { kind: 'red' }, 10, CONFIG);
    expect(board).toEqual([
      { kind: 'straight', value: 5, amount: 35 },
      { kind: 'red', amount: 10 }
    ]);
  });

  it('refuses a twenty-first spot, but still stacks onto one already placed', () => {
    const wide = { ...CONFIG, bet_max: 10_000 };
    let board: readonly Bet[] = [];
    for (let n = 0; n < 20; n++) board = addChip(board, { kind: 'straight', value: n }, 10, wide);
    expect(addChip(board, { kind: 'straight', value: 20 }, 10, wide)).toBe(board);
    expect(addChip(board, { kind: 'straight', value: 0 }, 10, wide)[0].amount).toBe(20);
  });

  it('refuses a chip that would take the board past the maximum', () => {
    const board = addChip([], { kind: 'red' }, 1000, CONFIG);
    expect(addChip(board, { kind: 'black' }, 10, CONFIG)).toBe(board);
  });

  it('offers chips inside the limits, the minimum first, six at most', () => {
    expect(chipValues({ bet_min: 10, bet_max: 100 })).toEqual([10, 25, 50, 100]);
    expect(chipValues({ bet_min: 7, bet_max: 30 })).toEqual([7, 10, 25]);
    const wide = chipValues({ bet_min: 1, bet_max: 50_000 });
    expect(wide.length).toBeLessThanOrEqual(6);
    expect(wide[0]).toBe(1);
    expect(wide[wide.length - 1]).toBe(50_000);
    expect([...wide].sort((a, b) => a - b)).toEqual(wide);
    expect(chipValues({ bet_min: 0, bet_max: 100 })).toEqual([]);
  });
});

describe('the crash curve', () => {
  it('starts at 1.00× and doubles every ten seconds', () => {
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(10_000)).toBe(200);
    expect(multiplierAt(20_000)).toBe(400);
    expect(multiplierAt(5_000)).toBe(141);
  });

  it('never reads below 1.00×, even on a clock that runs behind', () => {
    expect(multiplierAt(-500)).toBe(100);
  });

  it('inverts: the time to reach a multiplier lands back on it', () => {
    for (const m of [100, 150, 200, 333, 1000]) {
      expect(multiplierAt(elapsedFor(m) + 1)).toBe(m);
    }
    expect(elapsedFor(50)).toBe(0);
  });

  it('pays a cashout floored to a whole dollar', () => {
    expect(crashPayout(100, 250)).toBe(250);
    expect(crashPayout(33, 141)).toBe(46);
  });

  it('formats ×100 as a two-place multiplier', () => {
    expect(formatMultiplier(100)).toBe('1.00×');
    expect(formatMultiplier(1234)).toBe('12.34×');
  });

  it('holds a crash stake to the table limits', () => {
    expect(stakeProblem(10, CONFIG)).toBeNull();
    expect(stakeProblem(9, CONFIG)).toBe('below_min');
    expect(stakeProblem(1001, CONFIG)).toBe('above_max');
    expect(stakeProblem(12.5, CONFIG)).toBe('invalid_bet');
    expect(stakeProblem(Number.NaN, CONFIG)).toBe('invalid_bet');
  });
});
