import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const service = vi.hoisted(() => ({ call: vi.fn() }));

/**
 * The whole SDK, not `importOriginal` — the store's only use of it is `useService`, and
 * loading the real barrel would drag the component kit (and a DOM with it) into a suite
 * that needs neither. This file stays on the `node` default (`vite.config.ts`).
 */
vi.mock('@gphone/sdk', () => ({ useService: () => ({ call: service.call }) }));

import {
  buy,
  sell,
  loadPrice,
  loadPortfolio,
  priceStore,
  portfolioStore,
  tradeFailureMessage
} from './store';

/**
 * Hodlr's app-side data layer (MICA-59).
 *
 * ## Why this file exists, and what it covers that nothing else does
 *
 * `applyTrade` — the optimistic write that moves the holding the instant a trade settles —
 * had no test at either level, and the gap was invisible from both directions:
 *
 *   - `Trade.test.ts` mocks `buy`/`sell` out entirely, so it never reaches the store's own
 *     handling of the reply.
 *   - `e2e/apps/hodlr.spec.ts` looks like it covers this and does not. Returning from the
 *     trade screen swaps the `{#if}` in `index.svelte`, which destroys and re-creates
 *     `Portfolio.svelte`, whose `onMount` calls `loadPortfolio()`. The quantity the spec
 *     reads back is therefore a *fresh server read*, not the optimistic write — so
 *     `applyTrade` can be made a no-op and the whole e2e suite still passes. Verified by
 *     mutation rather than assumed: `return;` at the top of `applyTrade` left
 *     `hodlr.spec.ts` green while the same run caught planted bugs in Marketplace and Snek.
 *
 * That matters because the refetch is not guaranteed to save it. `service().call` answers
 * its `defaultValue` on a transport failure, and `loadPortfolio`'s default is a *zeroed*
 * portfolio — so on a dropped reply the optimistic value is the only correct number the
 * screen will ever hold.
 */
describe('hodlr store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    priceStore.set({ current: 0, history: [] });
    portfolioStore.set({ quantity: 3, currentPrice: 500, currentValue: 1500 });
  });

  describe('a settled trade moves the holding without waiting for a refetch', () => {
    it('writes the quantity the server settled on, and reprices it', async () => {
      service.call.mockResolvedValue({ ok: true, quantity: 5, price: 500, cost: 1000 });

      const outcome = await buy(2);

      expect(outcome).toEqual({ ok: true, quantity: 5, price: 500, cost: 1000 });
      // The server's `quantity` is absolute (the new holding), not a delta, and the value
      // is recomputed from the trade's own price rather than the stale `currentPrice`.
      expect(get(portfolioStore)).toEqual({ quantity: 5, currentPrice: 500, currentValue: 2500 });
    });

    it('reprices off the trade price even when the stored price has moved under it', async () => {
      // The market ticks between the portfolio read and the trade settling. `applyTrade`
      // must value the new holding at the price the trade actually executed at; taking
      // `currentPrice` from the store instead would report a number the player was never
      // charged.
      service.call.mockResolvedValue({ ok: true, quantity: 4, price: 600, proceeds: 600 });

      await sell(1);

      expect(get(portfolioStore).currentValue).toBe(2400);
    });

    it('leaves the holding alone when the server refuses', async () => {
      service.call.mockResolvedValue({ ok: false, reason: 'insufficient_holdings' });

      const outcome = await sell(999);

      expect(outcome).toEqual({ ok: false, reason: 'insufficient_holdings' });
      // A refusal that still moved the number would tell the player a trade happened.
      expect(get(portfolioStore)).toEqual({ quantity: 3, currentPrice: 500, currentValue: 1500 });
    });

    it('reports a dropped reply as request_failed and holds the line', async () => {
      // `useService.call` resolves its `defaultValue` rather than rejecting, so the store
      // sees a well-formed refusal and must not treat the fallback as a settled trade.
      service.call.mockImplementation(async (_action, _payload, defaultValue) => defaultValue);

      const outcome = await buy(2);

      expect(outcome).toEqual({ ok: false, reason: 'request_failed' });
      expect(get(portfolioStore).quantity).toBe(3);
    });
  });

  describe('the reads', () => {
    it('sends the quantity as the payload and names the action', async () => {
      service.call.mockResolvedValue({ ok: true, quantity: 5, price: 500 });

      await buy(2);
      expect(service.call).toHaveBeenCalledWith('buy', { quantity: 2 }, expect.anything());

      await sell(1);
      expect(service.call).toHaveBeenCalledWith('sell', { quantity: 1 }, expect.anything());
    });

    it('publishes the price and its history', async () => {
      const history = [{ price: 480, recorded_at: '2026-08-27T00:00:00Z' }];
      service.call.mockResolvedValue({ current: 520, history });

      await loadPrice();

      expect(get(priceStore)).toEqual({ current: 520, history });
    });

    it('publishes the portfolio as the server reports it', async () => {
      service.call.mockResolvedValue({ quantity: 9, currentPrice: 500, currentValue: 4500 });

      await loadPortfolio();

      expect(get(portfolioStore)).toEqual({ quantity: 9, currentPrice: 500, currentValue: 4500 });
    });
  });

  /**
   * MICA-99 put these sentences on screen; `Trade.test.ts` proves two of them reach the
   * player. The table itself is asserted here, because the server is what refuses — a
   * modified client can emit `gphone:server:hodlr:sell` directly (AGENTS.md §2.9) — so
   * every slug it can answer with has to be translatable, not just the ones the button
   * guard happens to let through.
   */
  describe('tradeFailureMessage', () => {
    it('names the holding in an over-sell, so the number is the one being refused', () => {
      expect(tradeFailureMessage('insufficient_holdings', 3)).toBe(
        'You only have 3 gCoin to sell.'
      );
    });

    it('has wording for every slug the server can answer with', () => {
      expect(tradeFailureMessage('insufficient_funds', 3)).toBe(
        'Your bank balance will not cover that.'
      );
      expect(tradeFailureMessage('debit_failed', 3)).toBe(
        'The bank refused the transfer. Nothing changed.'
      );
      expect(tradeFailureMessage('credit_failed', 3)).toBe(
        'The bank refused the transfer. Nothing changed.'
      );
      expect(tradeFailureMessage('request_failed', 3)).toBe(
        'The market did not answer. Try again.'
      );
    });

    it('falls through to a sentence rather than showing a slug it has no wording for', () => {
      const message = tradeFailureMessage('some_new_server_reason', 3);

      expect(message).toBe('That trade did not go through.');
      // The actual MICA-99 defect: the raw slug rendered into the screen.
      expect(message).not.toContain('some_new_server_reason');
      expect(message).not.toMatch(/_/);
    });
  });
});
