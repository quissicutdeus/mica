import { test, expect } from './support/test';
import {
  MAX_NAVIGATION_ATTEMPTS,
  NETWORK_CHANGED,
  survivesNetworkChange
} from './support/networkChange';

/**
 * MICA-314: the `page` fixture re-navigates when Chromium drops the shell's own bundle.
 *
 * What happened, and why it is handled in `support/networkChange.ts`, is written there. What
 * this file pins is that the handling *works*, because a rescue that never fires is
 * indistinguishable from no rescue until the day it matters.
 *
 * A real `net::ERR_NETWORK_CHANGED` cannot be provoked from a test: it needs the host's
 * interfaces to change, and Playwright's `route.abort` has no code for it. So the mechanism
 * is driven with `connectionreset` and a predicate that treats it as the transient failure,
 * through the same `survivesNetworkChange` the fixture installs. The *error text* the real
 * thing carries is pinned separately below, against the string a trace recorded.
 */
const RESET = /net::ERR_CONNECTION_RESET/;

test.describe('a page whose bundle is dropped mid-load', () => {
  test('is navigated again until the shell boots, and says so', async ({ page }) => {
    const retries: string[][] = [];
    survivesNetworkChange(page, {
      isTransient: (text) => RESET.test(text),
      onRetry: (urls) => retries.push(urls)
    });

    // The first script request of the first navigation is dropped; everything after passes.
    // That is exactly the shape of the failure: a document that loads, and an entry module
    // that never runs.
    let dropped = false;
    await page.route(/\/assets\/.*\.js$/, (route) => {
      if (dropped) return route.continue();
      dropped = true;
      return route.abort('connectionreset');
    });

    await page.goto('/');

    expect(dropped).toBe(true);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.[0]).toMatch(/\/assets\/.*\.js$/);
    // Booted: the shell's own frame, which a blank page does not have.
    await expect(page.getByTestId('phone-frame')).toBeVisible();
  });

  test('gives up, naming what it lost, rather than passing on a blank page', async ({ page }) => {
    survivesNetworkChange(page, { isTransient: (text) => RESET.test(text) });
    await page.route(/\/assets\/.*\.js$/, (route) => route.abort('connectionreset'));

    await expect(page.goto('/')).rejects.toThrow(
      new RegExp(`all ${MAX_NAVIGATION_ATTEMPTS} navigations[\\s\\S]*/assets/`)
    );
  });

  test('leaves every other failure alone', async ({ page }) => {
    const retries: string[][] = [];
    // The real predicate, so this is the fixture's own behaviour: a reset is not a network
    // change, and re-navigating over it would hide a server that is genuinely wrong.
    survivesNetworkChange(page, { onRetry: (urls) => retries.push(urls) });
    await page.route(/\/assets\/.*\.js$/, (route) => route.abort('connectionreset'));

    await page.goto('/');

    expect(retries).toHaveLength(0);
    await expect(page.getByTestId('phone-frame')).toHaveCount(0);
  });

  test('is recognised by the text Chromium actually reports', () => {
    // Copied from the console line a failed run's trace recorded, not invented.
    expect('net::ERR_NETWORK_CHANGED').toMatch(NETWORK_CHANGED);
    expect('Failed to load resource: net::ERR_NETWORK_CHANGED').toMatch(NETWORK_CHANGED);
    for (const other of ['net::ERR_ABORTED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_FAILED']) {
      expect(other).not.toMatch(NETWORK_CHANGED);
    }
  });
});
