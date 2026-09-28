import { test, expect, type Page } from './support/test';
import { settlePhoneOpen } from './support/phoneOpen';

/**
 * MICA-236: the boot and power-off screens. When they play is `state/power.ts`'s decision
 * (unit-tested); this drives it through the real shell: the browser's own first open, and
 * a battery push over the same `window.postMessage` channel the client uses.
 */

const setCharge = (page: Page, level: number) =>
  page.evaluate((data) => window.postMessage({ action: 'setCharge', data }, '*'), level);

const bootScreen = (page: Page) => page.getByTestId('boot-screen');

test.describe('boot and power-off screens', () => {
  test('boots on the first open, sits inside the screen, ends, and ignores input', async ({
    page
  }) => {
    await page.goto('/');
    await expect(bootScreen(page)).toHaveAttribute('data-phase', 'boot');
    // No owner logo configured: the mock answers `brandLogo: null` by default (MICA-236),
    // so this is the micaOS mark, not an image.
    await expect(page.getByTestId('boot-mark')).toBeAttached();
    await expect(bootScreen(page).locator('img')).toHaveCount(0);

    // Exactly the screen box: the frame's bezel inside, nothing over the player's game.
    const screen = await page.getByTestId('phone-screen').boundingBox();
    const overlay = await bootScreen(page).boundingBox();
    expect(screen && overlay).toBeTruthy();
    expect(Math.abs(overlay!.x - screen!.x)).toBeLessThan(2);
    expect(Math.abs(overlay!.width - screen!.width)).toBeLessThan(2);

    // Input passes straight through it.
    await expect(bootScreen(page)).toHaveClass(/pointer-events-none/);
    await expect(bootScreen(page)).toHaveAttribute('aria-hidden', 'true');

    // Short: gone well inside two seconds of the frame arriving.
    await expect(bootScreen(page)).toHaveCount(0, { timeout: 3000 });
  });

  test('shows the owner logo when one is configured', async ({ page }) => {
    // `?mica_brand_logo=` is the mock's own override for this (`nui/mocks/registry.ts`);
    // `/mock-branding/aurora.svg` is a fixture that already exists for the wallpaper tests,
    // reused here since which image loads is not what this test is about.
    await page.goto(`/?mica_brand_logo=${encodeURIComponent('/mock-branding/aurora.svg')}`);
    await expect(bootScreen(page)).toHaveAttribute('data-phase', 'boot');
    await expect(bootScreen(page).locator('img')).toHaveAttribute(
      'src',
      '/mock-branding/aurora.svg'
    );
    await expect(page.getByTestId('boot-mark')).toHaveCount(0);
  });

  test('falls back to the micaOS mark when the owner logo fails to load', async ({ page }) => {
    const missing = '/mock-branding/does-not-exist.svg';
    await page.goto(`/?mica_brand_logo=${encodeURIComponent(missing)}`);
    await expect(bootScreen(page)).toHaveAttribute('data-phase', 'boot');
    await expect(page.getByTestId('boot-mark')).toBeAttached();
    await expect(bootScreen(page).locator('img')).toHaveCount(0);
  });

  test('a phone that closes and reopens does not boot again', async ({ page }) => {
    await page.goto('/');
    await settlePhoneOpen(page);
    await expect(bootScreen(page)).toHaveCount(0, { timeout: 3000 });
    await page.getByRole('button', { name: 'Power' }).click();
    await expect(page.getByTestId('phone-frame')).toHaveCount(0);
    await page.getByRole('button', { name: /Open/ }).click();
    await settlePhoneOpen(page);
    await expect(bootScreen(page)).toHaveCount(0);
  });

  test('powers off when the battery dies, then shows the dead-battery screen', async ({ page }) => {
    await page.goto('/');
    await settlePhoneOpen(page);
    await expect(bootScreen(page)).toHaveCount(0, { timeout: 3000 });
    await setCharge(page, 0);
    await expect(bootScreen(page)).toHaveAttribute('data-phase', 'off');
    await expect(bootScreen(page)).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByText('Battery Low')).toBeVisible();
  });

  test('plays nothing under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await settlePhoneOpen(page);
    await expect(bootScreen(page)).toHaveCount(0);
  });
});
