// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. A test file is its own
 * entry point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const loads = vi.hoisted(() => ({
  loadPrice: vi.fn().mockResolvedValue(undefined),
  loadPortfolio: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return {
    ...actual,
    useHodlr: () => ({
      ...actual.useHodlr(),
      loadPrice: loads.loadPrice,
      loadPortfolio: loads.loadPortfolio
    })
  };
});

import Portfolio from './Portfolio.svelte';
import { currentApp } from '../../../shell/state/navigation';

import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';
import { priceStore, portfolioStore } from '../store';

// MICA-215: `index.svelte` registers the `hodlr` namespace; this test renders one screen.
registerMessages('hodlr', { en, de });

describe('Portfolio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    priceStore.set({ ready: true, current: 10, history: [] });
    portfolioStore.set({ ready: true, quantity: 5, currentPrice: 10, currentValue: 50 });
    currentApp.set({ id: 'hodlr', props: {} });
  });

  /**
   * MICA-413: it loaded in `onMount` and in `onAppForeground` both, and the foreground
   * handler fires on mount when the app is already in front, so the first open fetched
   * twice. One load per visit to the foreground.
   */
  it('loads once per visit to the foreground, not twice on the first', async () => {
    render(Portfolio, { props: { onbuy: () => {}, onsell: () => {} } });
    await screen.findByRole('button', { name: 'Buy' });
    expect(loads.loadPrice).toHaveBeenCalledTimes(1);
    expect(loads.loadPortfolio).toHaveBeenCalledTimes(1);

    currentApp.set({ id: 'home', props: {} });
    currentApp.set({ id: 'hodlr', props: {} });
    expect(loads.loadPrice).toHaveBeenCalledTimes(2);
    expect(loads.loadPortfolio).toHaveBeenCalledTimes(2);
  });

  /**
   * MICA-415: every amount through the SDK's `formatCurrency`, as Bank does. The quote was a
   * raw `$` and number (`$1500`), beside Bank's `$1,500.00` for the same kind of money.
   */
  it('formats the quote, both sides and the holding as currency', async () => {
    priceStore.set({ ready: true, current: 1500, buyPrice: 1515, sellPrice: 1485, history: [] });
    portfolioStore.set({ ready: true, quantity: 2, currentPrice: 1500, currentValue: 3000 });
    render(Portfolio, { props: { onbuy: () => {}, onsell: () => {} } });
    await screen.findByRole('button', { name: 'Buy' });
    expect(screen.getByText('$1,500.00')).toBeTruthy();
    expect(screen.getByText('$1,515.00')).toBeTruthy();
    expect(screen.getByText('$1,485.00')).toBeTruthy();
    expect(screen.getByText('worth $3,000.00')).toBeTruthy();
  });
});
