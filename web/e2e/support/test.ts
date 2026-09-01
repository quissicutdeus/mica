import { test as base, expect, type ConsoleMessage } from '@playwright/test';

export type { FrameLocator, Locator, Page } from '@playwright/test';
export { expect };

/**
 * `test` and `expect` for every spec in this suite, in place of `@playwright/test`'s own.
 *
 * The browser mock is the only transport Playwright ever drives, and until MICA-195 a
 * `fetchNui` call the registry did not know was answered with `null` and quietly turned
 * into the caller's `defaultValue` — so a feature with no mock passed every spec while
 * doing nothing, which is the same silent no-op AGENTS.md §8 describes for a missing
 * route, pointing the other way. The transport now lets the registry's throw out, and
 * `fetchNui` reports it the only way it can: a `console.warn` (for a read with a default)
 * or a rejection that ends up uncaught (for a write). Nothing read the console. Two specs
 * attached their own `page.on('console')` for their own reasons and nothing global did.
 *
 * This fixture is the global one. It attaches to `console` and `pageerror` before the
 * test body runs — so before any navigation — collects every message that reads as a
 * NUI failure, and fails the test at teardown with the messages. A spec does nothing to
 * opt in beyond importing from here rather than from `@playwright/test`.
 *
 * What counts as a failure, exactly, because a pattern that matches nothing makes every
 * spec vacuous and one that matches too much makes every spec red:
 *
 * - `[MockRegistry]` anywhere — the registry's own prefix, on the missing-mock throw and
 *   on the malformed-generic-request warning.
 * - `fetchNui('<action>') failed` and `fetchNui('<action>') returned an error` — the two
 *   messages `web/src/nui/fetchNui.ts` prints when it falls back to a default. A call
 *   made with `quiet: true` prints neither, so a missing mock behind one is invisible
 *   here; `server/__tests__/routes.test.ts` is the gate for that, statically.
 * - Any uncaught page error, in the main document or an add-on frame. A write with no
 *   default rejects instead of warning, and a store that does not catch it lands here.
 *
 * `allowNuiFailures` is the opt-out, for a spec that provokes one on purpose and asserts on
 * it. It is a `test.use` option so the exemption sits in the spec, in the open, scoped to a
 * file or a `describe` block, rather than in a list somewhere else that drifts.
 */
export interface NuiFixtureOptions {
  /**
   * Let a collected NUI failure pass. `false` everywhere unless a spec sets it with
   * `test.use({ allowNuiFailures: true })`, and it should say why beside that line.
   */
  allowNuiFailures: boolean;
}

/** The console output `fetchNui.ts` and `mocks/registry.ts` produce on a failure. */
const NUI_FAILURE_PATTERNS: readonly RegExp[] = [
  /\[MockRegistry\]/,
  /fetchNui\('[^']*'\) (?:failed|returned an error)/
];

const readsAsNuiFailure = (text: string): boolean =>
  NUI_FAILURE_PATTERNS.some((pattern) => pattern.test(text));

export const test = base.extend<NuiFixtureOptions>({
  allowNuiFailures: [false, { option: true }],

  page: async ({ page, allowNuiFailures }, use) => {
    const failures: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      const text = message.text();
      if (readsAsNuiFailure(text)) failures.push(`console.${message.type()}: ${text}`);
    });
    page.on('pageerror', (error: Error) => {
      failures.push(`pageerror: ${error.message}`);
    });

    await use(page);

    // A message the page printed in its last few milliseconds may still be in flight
    // when the test body returns. A round trip on the same session lands after it, so
    // the list below is complete for everything the test actually caused. Best effort:
    // a spec that closed its own page has nothing left to flush.
    if (!page.isClosed()) await page.evaluate(() => undefined).catch(() => undefined);

    if (allowNuiFailures || failures.length === 0) return;
    const plural = failures.length === 1 ? 'failure' : 'failures';
    throw new Error(
      `${failures.length} NUI ${plural} reached the console during this test, and the ` +
        'suite does not let one pass silently:\n\n' +
        failures.map((failure) => `  - ${failure}`).join('\n') +
        '\n\nA missing browser mock is the usual cause — the action needs an entry in ' +
        'web/src/nui/mocks/registry.ts (AGENTS.md §8). A spec that provokes this on ' +
        'purpose says so with test.use({ allowNuiFailures: true }).'
    );
  }
});
