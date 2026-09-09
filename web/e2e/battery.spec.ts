import { test, expect, type Page } from './support/test';
import { settlePhoneOpen } from './support/phoneOpen';

/**
 * MICA-193: the low-battery warning, driven through the same `window.postMessage`
 * channel the client pushes `setCharge` over (`shell/nuiMessages.ts`), so the real
 * message routing runs rather than a store poked from outside.
 *
 * The browser-mode drain loop in `state/charge.ts` ticks 1%/min underneath these pushes,
 * far too slow to cross a threshold inside one spec; every level here is set outright.
 */

const setCharge = (page: Page, level: number) =>
  page.evaluate((data) => window.postMessage({ action: 'setCharge', data }, '*'), level);

/** The visible toast card carrying the warning's title (`shell.batteryLow`). */
const warning = (page: Page) => page.locator('.pointer-events-auto', { hasText: 'Battery Low' });

test.describe('low-battery warning', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await settlePhoneOpen(page);
    await setCharge(page, 100);
    await expect(warning(page)).toHaveCount(0);
  });

  test('warns once at 20%, not again below it, and re-arms after charging', async ({ page }) => {
    await setCharge(page, 20);
    await expect(warning(page)).toHaveCount(1);
    await expect(warning(page)).toContainText('20%');

    // Still draining: the one toast stays, and its text still names the level it fired
    // at — a second firing would have replaced it in place with "19%".
    await setCharge(page, 19);
    await expect(warning(page)).toHaveCount(1);
    await expect(warning(page)).toContainText('20%');

    // Take it away, drain further: nothing new between the thresholds.
    await warning(page).click();
    await expect(warning(page)).toHaveCount(0);
    await setCharge(page, 12);
    await expect(warning(page)).toHaveCount(0);

    // Charging back above 20 re-arms it; the next drain to 20 warns again.
    await setCharge(page, 60);
    await setCharge(page, 20);
    await expect(warning(page)).toHaveCount(1);
  });

  test('warns again at 5%', async ({ page }) => {
    await setCharge(page, 20);
    await expect(warning(page)).toContainText('20%');
    await warning(page).click();
    await expect(warning(page)).toHaveCount(0);

    await setCharge(page, 5);
    await expect(warning(page)).toContainText('5%');
  });

  test('does not warn a dead phone', async ({ page }) => {
    await setCharge(page, 0);
    await expect(page.getByTestId('phone-frame')).toBeVisible();
    await expect(warning(page)).toHaveCount(0);
  });
});
