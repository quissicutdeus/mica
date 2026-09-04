import { test, expect } from './support/test';
import { seedHomeGrid } from './support/homeGrid';

test.describe('Phone Navigation & Home Screen', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Calculator and Store, both opened by
    // name below, have to already be placed there.
    await seedHomeGrid(page, ['calculator', 'store']);
    await page.goto('/');
  });

  test('displays micaOS header and app icons grid on home screen', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    // Scoped to the home screen region, not a bare `.grid` — `Dock.svelte`'s own icon
    // row is a CSS grid too now (aligned to the home grid's own columns), so an
    // unscoped `.grid` match is ambiguous between the two.
    const appGrid = page.getByRole('region', { name: 'Home Screen' }).locator('.grid');
    await expect(appGrid).toBeVisible();
  });

  test('opens Calculator app and returns home using Backspace', async ({ page }) => {
    await page.locator('button', { hasText: 'Calculator' }).click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    // Press Escape to return Home
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
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
      .locator('[data-testid="app-row"]', { hasText: 'Notes' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Return to home screen']").click();

    // 2. Verify the Notes icon appears on the home screen.
    // Role-based: apps stay resident once opened, so the Store's own catalog row is still
    // in the DOM behind this one, and only `inert` keeps it out of the accessibility tree.
    await expect(page.getByRole('button', { name: /Notes/ })).toBeVisible();

    // 3. Return to Store and open app details page to uninstall
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page.locator('[data-testid="app-row"]', { hasText: 'Notes' }).click();
    await page.locator('button', { hasText: 'Uninstall' }).first().click();

    // Confirm uninstallation in ConfirmDialog modal
    await expect(page.locator('h3', { hasText: 'Uninstall Notes' })).toBeVisible();
    await page.locator('button', { hasText: 'Uninstall' }).last().click();

    // 4. Return Home and verify Notes is uninstalled
    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(page.getByRole('button', { name: /Notes/ })).toHaveCount(0);
  });
});
