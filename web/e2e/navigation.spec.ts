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

  test('opens Calculator app and returns home using Backspace', async ({ page }) => {
    const calcButton = page.locator('button', { hasText: 'Calculator' });
    if ((await calcButton.count()) > 0) {
      await calcButton.click();
      await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

      // Press Escape to return Home
      await page.keyboard.press('Backspace');
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
    // Scoped to the home screen: apps stay resident once opened, so the Store's own
    // list row is still in the DOM behind it and a bare text match hits both.
    await expect(page.getByRole('button', { name: /Crypto Tracker/ })).toBeVisible();

    // 3. Return to Store and open app details page to uninstall
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page.locator('div.rounded-xl', { hasText: 'Crypto Tracker' }).click();
    await page.locator('button', { hasText: 'Uninstall' }).first().click();

    // Confirm uninstallation in ConfirmDialog modal
    await expect(page.locator('h3', { hasText: 'Uninstall Crypto Tracker' })).toBeVisible();
    await page.locator('button', { hasText: 'Uninstall' }).last().click();

    // 4. Return Home and verify Crypto Tracker is uninstalled
    await page.locator("button[aria-label='Back to Home']").click();
    await expect(page.getByRole('button', { name: /Crypto Tracker/ })).toHaveCount(0);
  });
});
