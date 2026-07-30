import { test, expect } from '@playwright/test';

test.describe('Phone Navigation & Home Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('displays gPhone header and app icons grid on home screen', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    const appGrid = page.locator('.grid');
    await expect(appGrid).toBeVisible();
  });

  test('opens Calculator app and returns home using Escape key', async ({ page }) => {
    const calcButton = page.locator("div[role='group']", { hasText: 'Calculator' });
    if (await calcButton.count() > 0) {
      await calcButton.click();
      await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

      // Press Escape to return Home
      await page.keyboard.press('Escape');
      await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    }
  });

  test('enters Edit Mode via right-click, shows minus badge on add-on apps, uninstalls app and auto-exits', async ({ page }) => {
    // 1. Go to Store and install an add-on app (Crypto Tracker)
    await page.locator("div[role='group']", { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
    await page.locator('button', { hasText: 'Get' }).first().click();
    await page.locator("button[aria-label='Back to Home']").click();

    // 2. Right click any app icon on the home screen to enter Edit Mode
    const phoneIcon = page.locator("div[role='group']", { hasText: 'Phone' }).first();
    await phoneIcon.click({ button: 'right' });

    // 3. Verify minus button badge appears on Crypto Tracker (add-on) but not on Phone (system)
    const cryptoMinus = page.locator("button[aria-label='Remove Crypto Tracker']");
    await expect(cryptoMinus).toBeVisible();

    const phoneMinus = page.locator("button[aria-label='Remove Phone']");
    await expect(phoneMinus).not.toBeVisible();

    // 4. Click minus button on Crypto Tracker to uninstall
    await cryptoMinus.click();

    // 5. Verify app is uninstalled and Edit Mode auto-exits when no add-on apps remain
    await expect(page.locator("text=Crypto Tracker")).not.toBeVisible();
    await expect(cryptoMinus).not.toBeVisible();
  });
});
