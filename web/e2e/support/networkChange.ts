import type { Page, Request } from '@playwright/test';

/**
 * Survive Chromium dropping a page's own assets because the host's network changed (MICA-314).
 *
 * `music.spec.ts`'s `beforeEach` failed twice in one verify run, on `cef-floor` only, with
 * `getByLabel('YouTube link')` "element(s) not found" at 5000ms. It looked like the app being
 * slow to render under load, and was not. A reproduction (the music spec pinned to one core,
 * six workers) caught the failure with its trace, and the trace says what happened:
 *
 *     Failed to load resource: net::ERR_NETWORK_CHANGED   vendor-*.css
 *     Failed to load resource: net::ERR_NETWORK_CHANGED   index-*.css
 *     Failed to load resource: net::ERR_NETWORK_CHANGED   contract-*.js, places-*.js, ...
 *
 * Seven requests, all failing within 300ms of each other, all for the shell's own bundle on
 * `127.0.0.1:4173`. Chromium aborts every in-flight request with that error when its network
 * change notifier sees the machine's interfaces or addresses change (a container or VPN
 * coming up on the same host, here). The document had loaded, so `page.goto` resolved
 * normally — a failed subresource does not fail the load event — but the shell's entry
 * module never ran, so the page stayed blank for ever and the first assertion about its
 * content timed out. The app had nothing to be slow about: it was never started.
 *
 * Two things follow. A longer timeout cannot help, since nothing will retry the request. And
 * it is not a music problem: any spec's first assertion after any `goto` is exposed to the
 * same window, which is why this lives in the `page` fixture (`test.ts`) rather than in the
 * one spec that happened to be hit.
 *
 * The fix is to treat "the page's own requests were dropped by the network changing" as the
 * condition it is — the navigation did not complete — and to navigate again, a bounded number
 * of times, saying so. Deliberately narrow:
 *
 * - **Only `ERR_NETWORK_CHANGED`.** A refused connection, a 404, a reset, an abort: those are
 *   a server or a test that is wrong, and re-navigating would hide them. Playwright's own
 *   `retries` is still 0; nothing here re-runs a test.
 * - **Never silent.** Every re-navigation is recorded as a `network-changed` annotation on the
 *   test, so a run that needed one says so in the report, and the third failure throws with
 *   the URLs it lost rather than passing on whatever the page managed to draw.
 * - **Only the navigation's own window.** A request that fails later, after `goto` has
 *   resolved, is not seen here.
 *
 * Which of the two is happening when a run is slow is the first thing to read in its trace:
 * `ERR_NETWORK_CHANGED` in the console is this; a long gap with no errors is load.
 */

/** Chromium's name for a request torn down because the network configuration changed. */
export const NETWORK_CHANGED = /net::ERR_NETWORK_CHANGED/;

/** One navigation plus two repeats. A third network change in a row is not weather. */
export const MAX_NAVIGATION_ATTEMPTS = 3;

export interface NetworkChangeOptions {
  /** Which failures count as the network changing. Overridden only to test this helper. */
  isTransient?: (errorText: string) => boolean;
  /** Told, once per repeated navigation, which URLs were lost. */
  onRetry?: (urls: string[]) => void;
}

/**
 * Run `navigate` until it completes without losing a request to a network change.
 *
 * Returns whatever `navigate` returns. A navigation that itself throws with the network
 * change (the document request was the one dropped) counts as lost too; any other throw
 * propagates untouched.
 */
export const navigateThroughNetworkChange = async <T>(
  page: Page,
  navigate: () => Promise<T>,
  { isTransient = (text) => NETWORK_CHANGED.test(text), onRetry }: NetworkChangeOptions = {}
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    const lost: string[] = [];
    const watch = (request: Request): void => {
      if (isTransient(request.failure()?.errorText ?? '')) lost.push(request.url());
    };
    page.on('requestfailed', watch);

    let result: T | undefined;
    let threw: unknown;
    try {
      result = await navigate();
      // A failure printed in the last few milliseconds may still be in flight when the
      // navigation resolves; a round trip on the same session lands after it.
      await page.evaluate(() => undefined).catch(() => undefined);
    } catch (error) {
      threw = error;
    } finally {
      page.off('requestfailed', watch);
    }

    if (threw !== undefined) {
      const message = threw instanceof Error ? threw.message : String(threw);
      if (!isTransient(message)) throw threw;
      lost.push(message);
    }
    if (lost.length === 0) return result as T;

    if (attempt >= MAX_NAVIGATION_ATTEMPTS) {
      throw new Error(
        `The page's requests were dropped by a network change on all ${MAX_NAVIGATION_ATTEMPTS} ` +
          `navigations (net::ERR_NETWORK_CHANGED), so the shell never booted. Lost on the last:\n` +
          lost.map((url) => `  - ${url}`).join('\n')
      );
    }
    onRetry?.(lost);
  }
};

/**
 * Make `page.goto` and `page.reload` go through {@link navigateThroughNetworkChange}.
 *
 * Patched on the instance, so a spec keeps calling `page.goto(...)` and nothing about how it
 * reads changes. `onRetry` is how the fixture turns a repeat into an annotation.
 */
export const survivesNetworkChange = (page: Page, options: NetworkChangeOptions = {}): void => {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = (url, init) => navigateThroughNetworkChange(page, () => goto(url, init), options);
  page.reload = (init) => navigateThroughNetworkChange(page, () => reload(init), options);
};
