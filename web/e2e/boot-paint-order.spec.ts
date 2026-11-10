import { test, expect } from './support/test';

/**
 * The boot screen has to be the first thing the player sees of the phone, not the second.
 *
 * The bug: the frame's own entrance (a 500ms opacity + fly-in) ran on its own, the boot
 * overlay waited out that whole flight as its `animation-delay`, and so the home screen
 * painted first, then the black boot screen faded in over it, then it faded out again
 * to the home screen — "loads the phone, then the loading screen, then the phone".
 * `boot-screen.spec.ts` could not see it: it asserts the boot is attached and later gone,
 * both true either way, and `settlePhoneOpen` waits the whole sequence out.
 *
 * So this watches the paint order instead. A `requestAnimationFrame` sampler is installed
 * before the page's own scripts run (`addInitScript`) and records, once per frame, how
 * visible the phone's screen content (screen and wallpaper, status bar, dock) is and how
 * opaque the boot overlay is *by its own animation*, ancestors excluded: the overlay lives inside
 * the frame, so a frame fading in around an already-opaque overlay shows black, not the
 * phone. The sampler stops itself once the boot has covered the screen and been removed,
 * and the test waits on that flag, never on a clock.
 *
 * Violation: any frame in which the phone's content is visible (>5%) before the overlay
 * has first reached full cover (>=95%). After that the phone legitimately shows through
 * the overlay's exit fade, so frames from then on are not judged.
 */

interface Sample {
  t: number;
  /** Most visible of the screen, status bar and dock: product of opacity up the ancestors. */
  phone: number;
  /** The overlay's own computed opacity; 0 when it is not in the DOM. */
  boot: number;
}

interface PaintLog {
  violations: Sample[];
  covered: boolean;
  done: boolean;
  last: Sample | null;
  frames: number;
}

test.describe('boot paint order', () => {
  test('no frame shows the phone before the boot screen covers it', async ({ page }) => {
    await page.addInitScript(() => {
      const log: PaintLog = { violations: [], covered: false, done: false, last: null, frames: 0 };
      (window as unknown as { __paintLog: PaintLog }).__paintLog = log;
      const t0 = performance.now();
      const ancestry = (el: Element | null): number => {
        let o = 1;
        for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
        return o;
      };
      const tick = () => {
        // The phone as a whole: the screen box (which carries the wallpaper as its own
        // background, so it stands for everything painted on it) and, separately, the
        // status bar and the dock, so a fix that hides one layer cannot pass.
        const layers = [
          '[data-testid="phone-screen"]',
          '[aria-label="Open notification shade"]',
          '[role="toolbar"][aria-label="Dock"]'
        ].map((q) => document.querySelector(q));
        const boot = document.querySelector('[data-testid="boot-screen"]');
        const sample: Sample = {
          t: Math.round(performance.now() - t0),
          phone: Math.max(0, ...layers.map((el) => (el ? ancestry(el) : 0))),
          boot: boot ? parseFloat(getComputedStyle(boot).opacity) : 0
        };
        log.frames++;
        log.last = sample;
        if (!log.covered) {
          if (sample.boot >= 0.95) log.covered = true;
          else if (sample.phone > 0.05) log.violations.push(sample);
        } else if (!boot) {
          log.done = true;
        }
        // A cap so a page that never boots ends the test with a clear failure, not a hang.
        if (!log.done && sample.t < 15000) requestAnimationFrame(tick);
        else log.done = true;
      };
      requestAnimationFrame(tick);
    });

    await page.goto('/');
    await page.waitForFunction(
      () => (window as unknown as { __paintLog: PaintLog }).__paintLog.done,
      null,
      { timeout: 20000 }
    );
    const log = await page.evaluate(
      () => (window as unknown as { __paintLog: PaintLog }).__paintLog
    );

    // The sampler must have actually seen a boot, or "no violations" is vacuous.
    expect(log.frames).toBeGreaterThan(10);
    expect(log.covered, 'the boot screen never reached full cover').toBe(true);
    expect(
      log.violations,
      `the phone painted before the boot screen covered it (first: ${JSON.stringify(log.violations[0])}, ${log.violations.length} frames)`
    ).toEqual([]);
    // And the phone is there once the boot has ended.
    expect(log.last?.phone ?? 0).toBeGreaterThan(0.95);
  });
});
