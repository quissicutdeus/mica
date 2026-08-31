import { test, expect } from '@playwright/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, installAddOn, openInstalledApp } from '../support/addon';

/**
 * Hodlr, end to end against the browser mock (MICA-59).
 *
 * `core: false`, so it is not in the launcher on a fresh boot: every test here installs it
 * through the Store first and drives it inside its sandboxed iframe. `?app=hodlr` would
 * skip that half, and the install is where an add-on actually becomes reachable.
 *
 * What this covers that the unit tests cannot: `Trade.test.ts` renders Trade against a
 * stubbed store, and `server/__tests__/hodlr.test.ts` drives the SQL. Neither exercises the
 * thing a player sees — that a settled trade propagates back out of the trade screen and
 * into the holding on the portfolio, through the store both screens share.
 *
 * The fixtures are `mockHodlrPrice` (500) and `mockHodlrHolding` (3 gCoin) in
 * `web/src/nui/mocks/data.ts`; the mock's buy/sell mutate that holding, so the numbers
 * below are the arithmetic of a real round trip rather than restated fixtures.
 */
test.describe('Hodlr', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Store has to already be placed there to
    // reach the install path.
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await installAddOn(page, 'Hodlr');
    await openInstalledApp(page, 'Hodlr');
    await expect(addOnFrame(page, 'hodlr').locator('h1', { hasText: 'Hodlr' })).toBeVisible();
  });

  test('prices the market, charts its history, and settles a buy into the holding', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'hodlr');

    // The three reads the portfolio makes on foreground, all of which arrive over the
    // generic `useService('hodlr')` route rather than a `shared/routes.ts` row.
    await expect(frame.getByText('$500', { exact: true })).toBeVisible();
    await expect(frame.getByText('3 gCoin', { exact: true })).toBeVisible();
    await expect(frame.getByText('worth $1500', { exact: true })).toBeVisible();

    // The chart, not the "No history yet" branch beside it. Asserting the plotted points
    // rather than the `<svg>` box is what distinguishes a chart with the mock's three
    // price points in it from an empty frame that also renders.
    await expect(frame.locator('svg polyline')).toHaveAttribute('points', /^[\d.,\s]+$/);

    await frame.getByRole('button', { name: 'Buy', exact: true }).click();
    // $505, not the $500 mid above: MICA-147's spread quotes a buy above mid — see
    // `mockHodlrBuyPrice` in `web/src/nui/mocks/data.ts`.
    await expect(frame.getByText('Buy gCoin at $505 each')).toBeVisible();

    // The running total is what a player checks before committing real money, and it is
    // priced from the same store the portfolio read.
    await frame.getByPlaceholder('Quantity').fill('2');
    await expect(frame.getByText('Cost: $1010')).toBeVisible();

    await frame.getByRole('button', { name: 'Confirm' }).click();

    // Back on the portfolio, with the holding moved: 3 + 2 gCoin at $500. The trade screen
    // closes itself only on a settled trade, and the mock's buy really did mutate the
    // fixture, so these two numbers are the arithmetic of a round trip.
    //
    // What this does *not* prove, despite reading as though it does: the optimistic write
    // in `store.ts`'s `applyTrade`. Returning here swaps the `{#if}` in `index.svelte`,
    // which destroys and re-creates `Portfolio.svelte`, and its `onMount` calls
    // `loadPortfolio()` — so the quantity below is a fresh server read either way.
    // `applyTrade` can be made a no-op and this spec stays green; that is measured, not
    // assumed. `src/apps/hodlr/store.test.ts` is what covers it.
    await expect(frame.getByText('5 gCoin', { exact: true })).toBeVisible();
    await expect(frame.getByText('worth $2500', { exact: true })).toBeVisible();
  });

  test('refuses a sell larger than the holding in words, then settles a legal one', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'hodlr');
    await frame.getByRole('button', { name: 'Sell', exact: true }).click();

    // $495, not $500 mid: MICA-147's spread quotes a sell below mid — see
    // `mockHodlrSellPrice` in `web/src/nui/mocks/data.ts`.
    await expect(frame.getByText('Sell gCoin at $495 each')).toBeVisible();
    await expect(frame.getByText('You hold 3 gCoin.')).toBeVisible();

    /**
     * MICA-99: over-selling left Confirm looking live and doing nothing at all. Both
     * halves of the fix are player-visible and both are asserted — the sentence, and the
     * button that will not fire. A disabled button on its own is indistinguishable from a
     * broken one, which is how the bug was reported.
     */
    await frame.getByPlaceholder('Quantity').fill('5');
    await expect(frame.getByText('You only have 3 gCoin to sell.')).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    await frame.getByPlaceholder('Quantity').fill('2');
    await expect(frame.getByText('You only have 3 gCoin to sell.')).toHaveCount(0);
    await expect(frame.getByText('Proceeds: $990')).toBeVisible();
    await frame.getByRole('button', { name: 'Confirm' }).click();

    await expect(frame.getByText('1 gCoin', { exact: true })).toBeVisible();
    await expect(frame.getByText('worth $500', { exact: true })).toBeVisible();
  });
});
