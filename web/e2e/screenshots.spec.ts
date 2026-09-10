// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from './support/test';
import { seedHomeGrid } from './support/homeGrid';
import { addOnFrame } from './support/addon';
import { settlePhoneOpen } from './support/phoneOpen';

/**
 * The README's screenshots, produced from the phone rather than pasted in (MICA-221).
 *
 * Not a test of anything: every capture here writes a PNG into `docs/screenshots/` and
 * asserts only that the screen it meant to photograph is on screen first. It lives in the
 * e2e tree because the e2e `webServer` is the one thing that boots the phone against the
 * mock transport without a game, and a spec is the only shape that gets to drive it.
 *
 * Skipped unless `SCREENSHOTS` is set, the same way `playwright.config.ts` gates the
 * `cef-floor` project on `CEF_FLOOR_CHROMIUM`: `pnpm test:e2e` must never rewrite committed
 * images as a side effect, and a spec that skips says so in the report rather than passing.
 *
 *   SCREENSHOTS=1 pnpm --filter web exec playwright test e2e/screenshots.spec.ts
 *
 * Dark scheme is the shipped default (`DEFAULT_THEME` in `web/src/services/theme.ts`), so
 * nothing is seeded for it. `deviceScaleFactor: 2` doubles the pixel grid so the 400x850
 * frame lands as an 800x1700 image that still reads at `width="200"` on a Retina display.
 */

/** `web/e2e/` → `docs/screenshots/`, from the repo root rather than the cwd. */
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/screenshots');

test.skip(
  !process.env.SCREENSHOTS,
  'set SCREENSHOTS=1 to regenerate docs/screenshots/ — the normal suite never writes them'
);

test.use({ deviceScaleFactor: 2 });

/** Clip to the frame — the bezel and screen — never the whole page. */
const capture = async (page: Page, name: string): Promise<void> => {
  await settlePhoneOpen(page);
  const frame = page.getByTestId('phone-frame');
  const clip = await frame.boundingBox();
  if (!clip) throw new Error('the phone frame is not on screen');
  // Fonts and the wallpaper's gradient are already painted by the time the fly-in has
  // settled; one animation frame more lets a just-mounted app's icons finish rasterising.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip, animations: 'disabled' });
};

test.describe('README screenshots', () => {
  test('home screen', async ({ page }) => {
    // The real grid starts empty (MICA-5); a README picture of an empty grid says nothing.
    await seedHomeGrid(page, [
      'phone',
      'messages',
      'contacts',
      'camera',
      'media',
      'bank',
      'mail',
      'jobs',
      'marketplace',
      'music',
      'places',
      'calculator',
      'store',
      'settings'
    ]);
    await page.goto('/');
    await expect(page.getByRole('toolbar', { name: 'Dock' })).toBeVisible();
    await capture(page, 'home');
  });

  test('messages thread', async ({ page }) => {
    await page.goto('/?app=messages');
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();
    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();
    await expect(page.locator('#messages-container')).toBeVisible();
    await capture(page, 'messages');
  });

  test('contacts', async ({ page }) => {
    await page.goto('/?app=contacts');
    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
    await capture(page, 'contacts');
  });

  test('media gallery', async ({ page }) => {
    await page.goto('/?app=media');
    await expect(page.getByRole('button', { name: /^Open photo \d+$/ }).first()).toBeVisible();
    await capture(page, 'media');
  });

  test('bank', async ({ page }) => {
    await page.goto('/?app=bank');
    await expect(page.getByRole('heading', { name: 'Recent Transactions' })).toBeVisible();
    await capture(page, 'bank');
  });

  test('settings', async ({ page }) => {
    await page.goto('/?app=settings');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    await capture(page, 'settings');
  });

  test('blabber add-on', async ({ page }) => {
    // `?app=` resolves against the component registry, so a `core: false` add-on opens
    // without the Store install the add-on specs walk through (`devHarness.ts`).
    await page.goto('/?app=blabber');
    // The sandboxed frame paints on its own schedule; wait for its header rather than its
    // document, or the picture is a blank iframe.
    await expect(addOnFrame(page, 'blabber').locator('h1', { hasText: 'Blabber' })).toBeVisible();
    await capture(page, 'blabber');
  });
});
