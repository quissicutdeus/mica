// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: a test file is its own entry point, so it says which side it stands in for:
 * in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { CasinoRound } from '@mica/shared/types';

import History from './History.svelte';
import { history, historyCursor, historyLoaded } from '../store';

import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `casino` namespace; this test renders one tab.
registerMessages('casino', { en, de });

const round = (over: Partial<CasinoRound>): CasinoRound => ({
  id: 1,
  game: 'roulette',
  status: 'settled',
  stake: 1500,
  payout: 0,
  multiplier: null,
  crash_point: null,
  number: 17,
  bets: null,
  created_at: '2026-10-22T12:00:00Z',
  ...over
});

/**
 * MICA-415: every amount through the SDK's `formatCurrency`, as Bank does. The catalog
 * carries the `$`; the number was interpolated raw, so `1500` read as `$1500` here and
 * `$1,500.00` in Bank.
 */
describe('Casino History', () => {
  beforeEach(() => {
    historyCursor.set(null);
    historyLoaded.set(true);
  });

  it('formats the stake and a win as currency', () => {
    history.set([round({ id: 1, payout: 3500 })]);
    render(History);
    expect(screen.getByText(/Staked \$1,500\.00/)).toBeTruthy();
    expect(screen.getByText('Won $2,000.00')).toBeTruthy();
  });

  /**
   * MICA-411: a win was `text-green-400`, a palette literal that ignores the scheme and
   * measures 1.49:1 on the light surface. A role instead, as Bank's money in.
   */
  it('draws a win with a themed role, not a palette green', () => {
    history.set([round({ id: 3, payout: 3500 })]);
    render(History);
    const won = screen.getByText('Won $2,000.00');
    expect(won.className).not.toMatch(/\btext-green-\d+/);
    expect(won.classList.contains('text-on-surface')).toBe(true);
  });

  it('formats a loss as currency', () => {
    history.set([round({ id: 2, stake: 1250, payout: 0 })]);
    render(History);
    expect(screen.getByText('Lost $1,250.00')).toBeTruthy();
  });
});
