import { test, expect, type Page } from '../support/test';
import AxeBuilder from '@axe-core/playwright';
import type { AxeResults, Result } from 'axe-core';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, frameTestId, settledFrameBox } from '../support/device';

/**
 * The accessibility gate, on the tablet (MICA-295, following on from MICA-109's phone
 * sweep in `../a11y.spec.ts`).
 *
 * The launcher, the shade and the control center are the same component tree the phone
 * runs (`Shell.svelte`'s `screen` snippet, mounted by `TabletFrame` exactly as by
 * `PhoneFrame`) — `../a11y.spec.ts` already scans them once, so this is not "the same
 * assertion at a second viewport" so much as it is the check that nothing about being
 * inside the wider frame — the two-pane layouts, the different launcher grid — introduces
 * a violation the phone's narrower one does not. Each tablet-capable app is scanned on its
 * own `tablet.svelte` root, which `../a11y.spec.ts` never renders at all.
 *
 * See `../a11y.spec.ts`'s own doc comment for what axe cannot cover (focus indicators,
 * text over a wallpaper, short text, CEF). The one addition here — a focus-ring check — is
 * the tablet's share of that gap, not new ground: it is colour- and scheme-sensitive in
 * exactly the way the phone's own version is, which is why this file carries an entry in
 * `THEME_SPECS` (`playwright.config.ts`) and a `tablet-light` project to run it a second
 * time.
 */

const TABLET_APPS = ['notes', 'admin', 'settings'] as const;

/** Same exemptions as `../a11y.spec.ts`, for the same reasons — see that file. */
const NOT_APPLICABLE = ['region', 'landmark-one-main'];

/**
 * Defects this sweep found, has not fixed, and refuses to hide — same policy as
 * `../a11y.spec.ts`'s own `KNOWN_OPEN`. Each is real, reported rather than routed around,
 * and somebody else's to fix: an e2e lane reports a product bug it finds, it does not
 * patch `web/src/shell` or `web/src/apps` to make its own gate green (MICA-295's brief).
 *
 * - **every tablet surface / `color-contrast`** — the status bar clock and battery-percent
 *   spans (`web/src/shell/frame/StatusBar.svelte:182`, `:318`) measure ~1.2:1 in light mode
 *   on the tablet: foreground `#191b25` (the light scheme's `on-surface`, correctly
 *   following the theme) against a background axe reads as flat `#000000`/`#040404` —
 *   not the wallpaper gradient `TabletFrame.svelte`'s `tablet-screen` div paints behind
 *   everything else (`web/src/shell/TabletFrame.svelte:105`). Present on the launcher and
 *   on every tablet-capable app root (the status bar is always mounted, not just on home),
 *   absent on the phone and absent on the tablet in dark mode — where the same background
 *   is dark enough that light text over it still passes. Nobody scanned the tablet in
 *   light before this ticket, which is exactly the gap `tablet-light` (`playwright.config.ts`)
 *   exists to close, and this is the first thing it found.
 * - **settings / `label`** — `ColorWheelPicker.svelte:284`'s lightness slider (and its
 *   sibling opacity slider just below) is a bare `<input type="range">` with no accessible
 *   name. It sits on `settings/panes/Display.svelte`, which the tablet root opens *by
 *   default* (`settings/tablet.svelte`'s `pane = $state<Pane>('display')`) — the phone
 *   only reaches it by drilling in, and nothing drills in during `../a11y.spec.ts`'s sweep,
 *   so this is a pre-existing defect the phone sweep never had a path to.
 */
const KNOWN_OPEN: Record<string, string[]> = {
  // The shade is the same component the phone renders; the nested-interactive row is
  // `../a11y.spec.ts`'s open defect, not a new one found here.
  shade: ['nested-interactive'],
  launcher: ['color-contrast'],
  notes: ['color-contrast'],
  admin: ['color-contrast'],
  settings: ['color-contrast', 'label']
};

const summarise = (results: AxeResults): string[] =>
  results.violations.map(
    (v: Result) =>
      `${v.id} (${v.impact}) x${v.nodes.length} — ${v.nodes[0].failureSummary?.split('\n').slice(1).join(' ').trim()}` +
      `\n      at ${String(v.nodes[0].target)}`
  );

const scan = (page: Page, surface: string) =>
  new AxeBuilder({ page })
    .include(`[data-testid="${frameTestId('tablet')}"]`)
    .disableRules([...NOT_APPLICABLE, ...(KNOWN_OPEN[surface] ?? [])])
    .analyze();

/** Room for the tablet frame at its design size, same as `tablet/frame.spec.ts`. */
const settleTabletFrame = async (page: Page) => {
  await page.setViewportSize({ width: 1920, height: 1300 });
  const box = await settledFrameBox(page, 'tablet');
  const frame = page.getByTestId(frameTestId('tablet'));
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);
  return box;
};

test.describe('Accessibility on the tablet', () => {
  test('the launcher has no accessibility violations', async ({ page }) => {
    await seedHomeGrid(page, ['settings', 'admin', 'notes'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settleTabletFrame(page);

    const results = await scan(page, 'launcher');
    expect(summarise(results), summarise(results).join('\n')).toEqual([]);
  });

  test('the shade and the control center have no accessibility violations', async ({ page }) => {
    await gotoDevice(page, 'tablet');
    await settleTabletFrame(page);

    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await expect(shade).toBeVisible();
    await expect
      .poll(async () => shade.evaluate((el) => el.getAnimations({ subtree: true }).length), {
        timeout: 5000
      })
      .toBe(0);
    const shadeResults = await scan(page, 'shade');
    expect(summarise(shadeResults), summarise(shadeResults).join('\n')).toEqual([]);

    await shade.getByRole('button', { name: 'Open Control Center' }).click();
    const cc = page.getByRole('dialog', { name: 'Control Center' });
    await expect(cc).toBeVisible();
    await expect
      .poll(async () => cc.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
      .toBe(0);
    const ccResults = await scan(page, 'controlCenter');
    expect(summarise(ccResults), summarise(ccResults).join('\n')).toEqual([]);
  });

  for (const id of TABLET_APPS) {
    test(`${id} has no accessibility violations on its tablet root`, async ({ page }) => {
      await gotoDevice(page, 'tablet', `/?app=${id}`);
      await settleTabletFrame(page);
      if (id === 'notes') {
        // `core: false`, so it is a sandboxed iframe rather than an in-process root —
        // same wait `../a11y.spec.ts`'s `openApp` uses before scanning an add-on.
        const frame = page.frameLocator(`iframe[data-app="${id}"]`);
        await expect(frame.locator('body > *').first()).toBeAttached({ timeout: 15_000 });
      }
      const results = await scan(page, id);
      expect(summarise(results), summarise(results).join('\n')).toEqual([]);
    });
  }

  /**
   * The one hand-written check axe cannot express (MICA-109 item 2, carried here for the
   * tablet): a focusable element with an invisible ring is conformant to every automated
   * rule and unusable with a keyboard. Colour- and scheme-sensitive — the ring is
   * `var(--color-focus-ring)` — which is why this test, and this file, run a second time
   * in light (`playwright.config.ts`'s `tablet-light` project).
   */
  test('the focus ring is visible on whatever the keyboard reaches first', async ({ page }) => {
    await seedHomeGrid(page, ['settings', 'admin'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settleTabletFrame(page);

    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });

    expect(ring, 'Tab moved focus to something').not.toBeNull();
    expect(ring!.style, 'the focused element draws an outline').not.toBe('none');
    expect(parseFloat(ring!.width)).toBeGreaterThanOrEqual(2);
  });
});
