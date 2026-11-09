import { test, expect, type Page } from './support/test';
import { installAddOn } from './support/addon';
import { seedHomeGrid } from './support/homeGrid';

/**
 * Evicting an add-on must release its iframe document (MICA-451).
 *
 * Add-ons have their own residency pool of three (MICA-447). Opening one past that evicts
 * the least recently used, and the shell removes its `<iframe>`. If anything still holds the
 * removed frame's window, its document stays in the heap, and a count of live documents —
 * which nothing on screen reflects — grows with every eviction.
 *
 * THIS SPEC MUST NEVER ENTER AN ADD-ON FRAME. No `frameLocator`, `contentFrame()`, frame
 * `evaluate` or locator inside one. Playwright leaves its InjectedScript in every frame it
 * evaluates in, held by a CDP console handle, and that alone retains the document of each
 * frame later evicted: +1 document and ~2.5 MB per eviction, in Chromium 103 only. The first
 * version of this spec did enter the frames and went red on that, measuring Playwright
 * rather than the shell. Everything below waits on the outer page: the `<iframe>` element
 * and an attribute the outer page puts on it.
 *
 * The assertion is relative: take the count after every add-on has been opened once (so each
 * one's images are already loaded and counted) with the pool full, run several more
 * evictions, and require the count not to have grown.
 *
 * Playwright drives a modern Chromium, and the `cef-floor` project a Chromium 103 standing
 * in for FiveM's CEF; neither is the CEF itself.
 */

/** The add-on pool size, restated from `shell/state/navigation.ts` (MAX_RESIDENT_ADDONS). */
const POOL = 3;
/** More than the pool, so every open once the pool is full is a miss and evicts one. */
const ADDONS = [
  ['Notes', 'notes'],
  ['Blabber', 'blabber'],
  ['Glimpse', 'glimpse'],
  ['Snek', 'snek'],
  ['Spark', 'spark']
] as const;

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

test.describe('add-on eviction', () => {
  test('leaves no extra documents behind once the pool has evicted', async ({ page }) => {
    // Marks each add-on `<iframe>` as loaded from the outer page, by a capture listener —
    // `load` does not bubble. An attribute rather than a map of frames, because holding a
    // reference to an iframe here would itself keep its document alive.
    await page.addInitScript(() => {
      document.addEventListener(
        'load',
        (event) => {
          const target = event.target;
          if (target instanceof HTMLIFrameElement) target.dataset.loaded = '1';
        },
        true
      );
    });
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();

    for (const [name] of ADDONS) await installAddOn(page, name);

    const frameOf = (id: string) => page.locator(`iframe[data-app="${id}"]`);
    const home = page.locator("button[aria-label='Return to home screen']");
    /** Open one add-on, wait for its frame to load, and return home. Outer page only. */
    const open = async (index: number): Promise<void> => {
      const [name, id] = ADDONS[index % ADDONS.length]!;
      await page.getByRole('button', { name: new RegExp(name) }).click();
      await expect(page.locator(`iframe[data-app="${id}"][data-loaded]`)).toHaveCount(1);
      await home.click();
      await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();
    };

    // One lap of everything: the pool fills, then two evictions.
    for (let i = 0; i < ADDONS.length; i += 1) await open(i);
    await expect(page.locator('iframe[data-app]')).toHaveCount(POOL);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const baseline = await documentsAfterGc(cdp);
    expect(baseline, 'the page reports no documents at all').toBeGreaterThan(POOL);

    // Six more opens, each a miss past a full pool, so six evictions.
    const ROUNDS = 6;
    for (let i = 0; i < ROUNDS; i += 1) {
      const next = ADDONS.length + i;
      // The add-on opened `POOL` opens ago is the one this evicts.
      const evicted = ADDONS[(next - POOL) % ADDONS.length]![1];
      await open(next);
      await expect(frameOf(evicted)).toHaveCount(0);
      await expect(page.locator('iframe[data-app]')).toHaveCount(POOL);
    }

    // A released document can take a collection or two to be reported gone, so poll the
    // forced-GC count rather than read it once; a leak never comes down and times out.
    let after = baseline;
    await expect
      .poll(async () => (after = await documentsAfterGc(cdp)), {
        message: `documents after ${ROUNDS} evictions (baseline ${baseline})`,
        timeout: 10_000
      })
      .toBeLessThanOrEqual(baseline);
    console.log(`MICA-451 documents: baseline ${baseline}, after ${ROUNDS} evictions ${after}`);
  });
});
