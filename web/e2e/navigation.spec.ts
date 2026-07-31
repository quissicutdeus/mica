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
    const calcButton = page.locator('button', { hasText: 'Calculator' });
    if ((await calcButton.count()) > 0) {
      await calcButton.click();
      await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

      // Press Escape to return Home
      await page.keyboard.press('Escape');
      await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    }
  });

  test('installs and uninstalls add-on app via the Store', async ({ page }) => {
    // 1. Go to Store and install an add-on app (Crypto Tracker)
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();

    // Click Install button specifically for Crypto Tracker
    await page
      .locator('div.rounded-xl', { hasText: 'Crypto Tracker' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Back to Home']").click();

    // 2. Verify Crypto Tracker icon appears on home screen
    await expect(page.locator('button', { hasText: 'Crypto Tracker' })).toBeVisible();

    // 3. Return to Store and open app details page to uninstall
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page.locator('div.rounded-xl', { hasText: 'Crypto Tracker' }).click();
    await page.locator('button', { hasText: 'Uninstall' }).first().click();

    // Confirm uninstallation in ConfirmDialog modal
    await expect(page.locator('h3', { hasText: 'Uninstall Crypto Tracker' })).toBeVisible();
    await page.locator('button', { hasText: 'Uninstall' }).last().click();

    // 4. Return Home and verify Crypto Tracker is uninstalled
    await page.locator("button[aria-label='Back to Home']").click();
    await expect(page.locator('button', { hasText: 'Crypto Tracker' })).not.toBeVisible();
  });
});
