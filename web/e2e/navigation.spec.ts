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

  /**
   * Notes rather than Crypto Tracker, which was one of four invented catalog entries with
   * no code behind them and has been removed. Notes is a real in-repo add-on, which is what
   * makes this round trip mean anything: installing a fiction registered a placeholder
   * screen and still reported success, so the assertions below passed without the install
   * having produced a usable app.
   */
  test('installs and uninstalls add-on app via the Store', async ({ page }) => {
    // 1. Go to Store and install an add-on app
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();

    await page
      .locator('div.rounded-xl', { hasText: 'Notes' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Return to home screen']").click();

    // 2. Verify the Notes icon appears on the home screen.
    // Role-based: apps stay resident once opened, so the Store's own catalog row is still
    // in the DOM behind this one, and only `inert` keeps it out of the accessibility tree.
    await expect(page.getByRole('button', { name: /Notes/ })).toBeVisible();

    // 3. Return to Store and open app details page to uninstall
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page.locator('div.rounded-xl', { hasText: 'Notes' }).click();
    await page.locator('button', { hasText: 'Uninstall' }).first().click();

    // Confirm uninstallation in ConfirmDialog modal
    await expect(page.locator('h3', { hasText: 'Uninstall Notes' })).toBeVisible();
    await page.locator('button', { hasText: 'Uninstall' }).last().click();

    // 4. Return Home and verify Notes is uninstalled
    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(page.getByRole('button', { name: /Notes/ })).toHaveCount(0);
  });
});
