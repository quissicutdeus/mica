import { test, expect, type Browser, type Page } from './support/test';
import { seedHomeGrid } from './support/homeGrid';

/**
 * An add-on frame that dies of an uncaught error must still be released when the shell
 * removes it (MICA-469).
 *
 * In Chromium 103 a frame whose script ended in an uncaught error, or an unhandled promise
 * rejection, keeps its document and window after its `<iframe>` is removed — measured with
 * bare CDP and no debugger attached: five such frames removed left six documents, and with
 * the error event cancelled inside the frame, one. MICA-451 proved the plain eviction path
 * clean, so this guards the other half: every add-on crash otherwise pins its frame for the
 * rest of a play session.
 *
 * The method is MICA-451's, and so is its one hard rule: THIS SPEC MUST NEVER ENTER AN
 * ADD-ON FRAME (no `frameLocator`, `contentFrame()`, frame `evaluate`). Playwright's injected
 * script pins every frame it touches in 103 and would manufacture a leak of its own. All the
 * waiting is on the outer page: the `<iframe>` element, an attribute the outer page puts on
 * it, and the console lines the frames print, which reach the page's `console` event without
 * Playwright evaluating anything in them. Cancelling the error in the frame removes its own
 * "Uncaught" line, so no assertion here depends on that line — only on documents.
 *
 * The three modes run the same procedure and differ only in how the bundle ends, so the
 * `none` run is the baseline the crashing runs are held to, each in a context of its own so
 * one run's documents cannot appear in another's count. Each run opens POOL add-ons, which
 * fill the pool, then POOL plain ones, which evict every one of the first; the count is taken
 * once the evicted `<iframe>`s are gone, after a forced GC.
 *
 * Every bundle says `hello` and then prints `booted:<id>` before it does anything else, and
 * the spec waits for all of them, and for `crashing:<id>` after: a "fix" that stopped the frame loading would otherwise pass
 * by there being nothing to leak.
 *
 * Playwright drives a modern Chromium, and the `cef-floor` project a Chromium 103 standing
 * in for FiveM's CEF; neither is the CEF itself.
 */

// Frames throw on purpose, and the suite's global fixture would fail the test on each.
test.use({ allowNuiFailures: true });
// Trace DOM snapshots inject into every frame and, under load, pin a crashed or evicted one in
// Chromium 103 (MICA-469); keep the trace itself, drop the snapshots.
test.use({ trace: { mode: 'retain-on-failure', snapshots: false, screenshots: true } });

/** The add-on pool size, restated from `shell/state/navigation.ts` (MAX_RESIDENT_ADDONS). */
const POOL = 3;

type Mode = 'none' | 'error' | 'rejection';

const manifestFor = (id: string, name: string) =>
  JSON.stringify({ id, name, tile: { bg: 'bg-red-500' }, icon: null, core: false });

/** What each mode does once the shell has been told the add-on is up. */
const ENDINGS: Record<Mode, string> = {
  none: '',
  error: `setTimeout(() => { console.log('crashing:' + ID); throw new Error('uncaught on purpose'); }, 0);`,
  rejection: `setTimeout(() => { console.log('crashing:' + ID); Promise.reject(new Error('unhandled on purpose')); }, 0);`
};

const bundleFor = (id: string, mode: Mode): string => `
  const ID = ${JSON.stringify(id)};
  parent.postMessage({ kind: 'hello', appId: ID }, '*');
  document.getElementById('app').textContent = ID;
  console.log('booted:' + ID);
  ${ENDINGS[mode]}
`;

type CdpSession = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

/** Force a full GC over CDP, then read the `Documents` metric. */
const documentsAfterGc = async (cdp: CdpSession): Promise<number> => {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const documents = metrics.find((m) => m.name === 'Documents');
  // A metric that is not there would make every comparison below vacuous.
  if (!documents) throw new Error('Performance.getMetrics reported no Documents metric');
  return documents.value;
};

/** Run the procedure for one mode in a context of its own, and return the settled count. */
const measure = async (
  browser: Browser,
  viewport: { width: number; height: number } | null | undefined,
  mode: Mode,
  limit = 0
): Promise<number> => {
  const context = await browser.newContext(viewport ? { viewport } : {});
  try {
    const page = await context.newPage();
    const lines: string[] = [];
    page.on('console', (message) => lines.push(message.text()));
    await page.addInitScript(() => {
      document.addEventListener(
        'load',
        (event) => {
          if (event.target instanceof HTMLIFrameElement) event.target.dataset.loaded = '1';
        },
        true
      );
    });
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();

    const crashers = Array.from({ length: POOL }, (_, i) => `crash${i}`);
    const plain = Array.from({ length: POOL }, (_, i) => `plain${i}`);
    await page.evaluate(
      ([entries]) => {
        for (const [manifest, source] of entries!) {
          window.appRegistryStore.registerAddOn(JSON.parse(manifest!), source!);
        }
      },
      [
        [
          ...crashers.map((id) => [manifestFor(id, `Probe ${id}`), bundleFor(id, mode)]),
          ...plain.map((id) => [manifestFor(id, `Probe ${id}`), bundleFor(id, 'none')])
        ]
      ] as [string[][]]
    );

    const home = page.locator("button[aria-label='Return to home screen']");
    /**
     * Open one add-on and wait, on the outer page only, for it to boot. A crashing one is
     * removed by the shell itself once its error reaches it, or left resident for eviction to
     * take, depending on the kind and the build; either way it may never be seen loaded, so
     * its `booted` line is the boot signal and the removal is asserted below, not here.
     */
    const open = async (id: string): Promise<void> => {
      const crashes = mode !== 'none' && id.startsWith('crash');
      await page.getByRole('button', { name: `Probe ${id}` }).click();
      await expect.poll(() => lines.includes(`booted:${id}`)).toBe(true);
      if (crashes) {
        await expect.poll(() => lines.includes(`crashing:${id}`)).toBe(true);
      } else {
        await expect(page.locator(`iframe[data-app="${id}"][data-loaded]`)).toHaveCount(1);
      }
      await home.click();
      await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();
    };

    for (const id of crashers) await open(id);
    for (const id of plain) await open(id);
    // Each plain open evicts the least recently used: no crasher is left in any mode.
    for (const id of crashers)
      await expect(page.locator(`iframe[data-app="${id}"]`)).toHaveCount(0);
    await expect(page.locator('iframe[data-app]')).toHaveCount(POOL);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    // A released document can take a collection or two to be reported gone, so poll the
    // forced-GC count until it is at the limit or has stopped moving for several reads in a
    // row. A pinned frame never comes down, so it ends by holding still above the limit.
    let last = Infinity;
    let still = 0;
    await expect
      .poll(
        async () => {
          const now = await documentsAfterGc(cdp);
          still = now === last ? still + 1 : 0;
          last = now;
          return now <= limit || still >= 4;
        },
        { timeout: 20_000, intervals: [100, 250, 500, 1000] }
      )
      .toBe(true);
    return last;
  } finally {
    await context.close();
  }
};

test.describe('add-on crash', () => {
  for (const mode of ['error', 'rejection'] as const) {
    test(`releases the frame of an add-on that ends in ${mode === 'error' ? 'an uncaught error' : 'an unhandled rejection'}`, async ({
      browser
    }, testInfo) => {
      test.setTimeout(90_000);
      const viewport = testInfo.project.use.viewport;
      const baseline = await measure(browser, viewport, 'none');
      expect(baseline, 'the baseline reports no documents at all').toBeGreaterThan(POOL);
      const after = await measure(browser, viewport, mode, baseline);
      console.log(
        `MICA-469 documents: baseline ${baseline}, after ${POOL} ${mode} frames ${after}`
      );
      expect(after, `documents after ${POOL} crashed frames were evicted`).toBeLessThanOrEqual(
        baseline
      );
    });
  }
});
