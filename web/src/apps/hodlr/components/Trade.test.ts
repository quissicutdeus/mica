// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

const action = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock('@gos/sdk', async (importOriginal) => {
  const { writable } = await import('svelte/store');
  return {
    ...(await importOriginal<object>()),
    // The real hook toasts and swallows; this keeps the thrown message assertable, which
    // is the whole point of MICA-99 — a refusal the player can read.
    useAppAction: () => ({
      busy: writable(false),
      notify: () => {},
      run: async (work: () => unknown) => {
        try {
          await work();
          return true;
        } catch (e) {
          action.errors.push((e as Error).message);
          return false;
        }
      }
    })
  };
});

const trades = vi.hoisted(() => ({ buy: vi.fn(), sell: vi.fn() }));
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return {
    ...actual,
    useHodlr: () => ({ ...actual.useHodlr(), buy: trades.buy, sell: trades.sell })
  };
});

import Trade from './Trade.svelte';

import { registerMessages } from '@gos/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `hodlr` namespace for the running add-on. This
// test renders Trade on its own, so it stands in for the entry point — otherwise every
// `$t` here, and `tradeFailureMessage` with it, resolves to its own key.
registerMessages('hodlr', { en, de });
import { priceStore, portfolioStore } from '../store';

/**
 * MICA-99: selling more gCoin than you hold left Confirm looking live and doing
 * nothing at all — no balance change, no message. The button guard existed; what was
 * missing was anything telling the player why it would not fire, and any handling of the
 * server's own refusal beyond printing its slug.
 */
describe('Trade', () => {
  // eslint's type info disagrees with svelte-check here, as it does in
  // `marketplace/components/CreateListing.test.ts`: `screen.getByText` is typed
  // `HTMLElement`, which has no `.disabled`, so tsc genuinely needs the assertion.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const confirm = () => screen.getByText('Confirm') as HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
    action.errors.length = 0;
    priceStore.set({ ready: true, current: 10, history: [] });
    portfolioStore.set({ ready: true, quantity: 5, currentPrice: 10, currentValue: 50 });
  });

  const enter = (value: string) =>
    fireEvent.input(screen.getByPlaceholderText('Quantity'), { target: { value } });

  /**
   * MICA-147/MICA-149: a spread means buy and sell are genuinely different numbers,
   * and pricing both sides off `current` was the bug this replaces — a buy quoted at the
   * sell price undercharges whatever the server actually settles at.
   */
  it('quotes and totals a buy at buyPrice, not at the mid or the sell price', async () => {
    priceStore.set({ ready: true, current: 10, buyPrice: 12, sellPrice: 9, history: [] });
    render(Trade, { props: { side: 'buy', onback: () => {} } });

    expect(screen.getByText('Buy gCoin at $12 each')).toBeTruthy();

    await enter('3');
    expect(screen.getByText('Cost: $36')).toBeTruthy();
  });

  it('quotes and totals a sell at sellPrice, not at the mid or the buy price', async () => {
    priceStore.set({ ready: true, current: 10, buyPrice: 12, sellPrice: 9, history: [] });
    render(Trade, { props: { side: 'sell', onback: () => {} } });

    expect(screen.getByText('Sell gCoin at $9 each')).toBeTruthy();

    await enter('3');
    expect(screen.getByText('Proceeds: $27')).toBeTruthy();
  });

  it('falls back to the mid price on both sides when no spread has been sent', async () => {
    priceStore.set({ ready: true, current: 10, history: [] });
    render(Trade, { props: { side: 'buy', onback: () => {} } });

    expect(screen.getByText('Buy gCoin at $10 each')).toBeTruthy();
  });

  it('refuses a sell above the holding and says how many gCoin there actually are', async () => {
    render(Trade, { props: { side: 'sell', onback: () => {} } });

    await enter('999');

    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('You only have 5 gCoin to sell.')).toBeTruthy();
    expect(trades.sell).not.toHaveBeenCalled();
  });

  it('allows a sell of the whole holding', async () => {
    render(Trade, { props: { side: 'sell', onback: () => {} } });

    await enter('5');

    expect(confirm().disabled).toBe(false);
    expect(screen.queryByText(/You only have/)).toBeNull();
  });

  it('names a fractional quantity as the problem rather than sitting mute', async () => {
    render(Trade, { props: { side: 'sell', onback: () => {} } });

    await enter('1.5');

    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('Enter a whole number of gCoin.')).toBeTruthy();
  });

  it('never caps a buy against the holding — that is the bank’s business', async () => {
    render(Trade, { props: { side: 'buy', onback: () => {} } });

    await enter('999');

    expect(confirm().disabled).toBe(false);
    expect(screen.queryByText(/You only have/)).toBeNull();
  });

  it('turns a server refusal into a sentence and stays on the form', async () => {
    // The guard above is a courtesy: the server refuses independently (AGENTS.md §2.9),
    // and a holding that shrank since the last load reaches exactly this path.
    trades.sell.mockResolvedValue({ ok: false, reason: 'insufficient_holdings' });
    const onback = vi.fn();
    render(Trade, { props: { side: 'sell', onback } });

    await enter('4');
    await fireEvent.click(confirm());

    expect(action.errors).toEqual(['You only have 5 gCoin to sell.']);
    expect(onback).not.toHaveBeenCalled();
  });

  it('does not show a raw server slug for a reason it has no wording for', async () => {
    trades.sell.mockResolvedValue({ ok: false, reason: 'market_halted' });
    render(Trade, { props: { side: 'sell', onback: () => {} } });

    await enter('1');
    await fireEvent.click(confirm());

    expect(action.errors).toEqual(['That trade did not go through.']);
  });

  /**
   * MICA-130: the server refuses every trade until it has restored the price from storage
   * after a restart, and withholds the quote while it has not. Portfolio disables the
   * buttons that reach this screen, but the screen stays mounted while the market state can
   * change underneath it — and a greyed Confirm with nothing beside it is the exact shape
   * MICA-99 was reported as.
   */
  it('will not trade, and says why, while the market has no price yet', async () => {
    priceStore.set({ ready: false, current: 0, history: [] });
    render(Trade, { props: { side: 'buy', onback: () => {} } });

    await enter('1');

    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('The market is still opening. Try again in a moment.')).toBeTruthy();
    // Never the withheld quote dressed up as a real one.
    expect(screen.queryByText(/at \$0 each/)).toBeNull();
    expect(trades.buy).not.toHaveBeenCalled();
  });

  it('leaves the trade screen once the sell is accepted', async () => {
    trades.sell.mockResolvedValue({ ok: true, quantity: 2, price: 10, proceeds: 30 });
    const onback = vi.fn();
    render(Trade, { props: { side: 'sell', onback } });

    await enter('3');
    await fireEvent.click(confirm());

    expect(trades.sell).toHaveBeenCalledWith(3);
    expect(onback).toHaveBeenCalled();
    expect(action.errors).toEqual([]);
  });
});
