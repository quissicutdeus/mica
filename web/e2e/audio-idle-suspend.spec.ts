import { test, expect, type Page } from './support/test';

/**
 * MICA-373: the shell suspends its AudioContext ten idle seconds after the last sound and
 * wakes it before the next.
 *
 * The shell exposes no hook for the context's state, so this wraps `window.AudioContext`
 * with an init script (test-side only, no production change) that keeps every instance on
 * `window.__audioContexts`. The ten seconds are advanced with `page.clock`, not waited.
 *
 * A click on the Volume Up button is the sound: `adjustVolume` plays the `click` effect,
 * and a Playwright click is a real user gesture, so the autoplay policy lets it resume.
 *
 * What this cannot prove: whether the release CEF 103 allows `resume()` after a suspend
 * without a fresh gesture (here the second sound is itself a gesture), nor that anything is
 * audible. It asserts the context's `state` only.
 */
type Probe = Window & { __audioContexts?: AudioContext[] };

const states = (page: Page) =>
  page.evaluate(() => ((window as Probe).__audioContexts ?? []).map((ctx) => ctx.state));

test.describe('Audio idle suspend', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const Real = window.AudioContext;
      const seen: AudioContext[] = [];
      (window as Probe).__audioContexts = seen;
      class Recording extends Real {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          seen.push(this);
        }
      }
      window.AudioContext = Recording;
    });
    await page.clock.install();
    await page.goto('/');
  });

  test('suspends after ten idle seconds, and the next sound resumes it', async ({ page }) => {
    // Boot prefetch creates the context, but with no gesture yet it is not running.
    expect(await states(page)).not.toContain('running');

    await page.locator("button[aria-label='Volume Up']").click();
    await expect.poll(() => states(page)).toEqual(['running']);

    // Not yet: the window has not elapsed.
    await page.clock.fastForward(5_000);
    expect(await states(page)).toEqual(['running']);

    await page.clock.fastForward(6_000);
    await expect.poll(() => states(page)).toEqual(['suspended']);

    // The next sound wakes the same context rather than making another.
    await page.locator("button[aria-label='Volume Up']").click();
    await expect.poll(() => states(page)).toEqual(['running']);
  });

  test('a sound inside the window re-arms the countdown', async ({ page }) => {
    await page.locator("button[aria-label='Volume Up']").click();
    await expect.poll(() => states(page)).toEqual(['running']);

    await page.clock.fastForward(8_000);
    await page.locator("button[aria-label='Volume Down']").click();
    // Sixteen seconds since the first sound but only eight since the second.
    await page.clock.fastForward(8_000);
    expect(await states(page)).toEqual(['running']);

    await page.clock.fastForward(3_000);
    await expect.poll(() => states(page)).toEqual(['suspended']);
  });
});
