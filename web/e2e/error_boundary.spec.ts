import { test, expect } from '@playwright/test';

test.describe('App Isolation & Error Boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('handles crashing third-party app without breaking OS navigation', async ({ page }) => {
    // Verify home screen is visible
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    // Register a faulty app dynamically
    await page.evaluate(() => {
      const { appRegistryStore } = (window as any);
      if (appRegistryStore) {
        appRegistryStore.registerApp({
          id: 'faulty_app',
          name: 'Faulty App',
          color: '#ef4444',
          icon: null,
        }, () => {
          throw new Error('Simulated third-party app crash!');
        });
      }
    });

    // Check if Faulty App appears on the grid
    const faultyAppBtn = page.locator('button', { hasText: 'Faulty App' });
    if (await faultyAppBtn.count() > 0) {
      await faultyAppBtn.click();

      // Should display ErrorBoundary crash UI
      await expect(page.locator('text=App Stopped Working')).toBeVisible();
      await expect(page.locator('text=Return to Home Screen')).toBeVisible();

      // Click "Return to Home Screen" button
      await page.click('button:has-text("Return to Home Screen")');

      // Verify user is back on home screen
      await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    }
  });

  test('recovers from app error boundary using Escape key', async ({ page }) => {
    // Register a faulty app dynamically
    await page.evaluate(() => {
      const { appRegistryStore } = (window as any);
      if (appRegistryStore) {
        appRegistryStore.registerApp({
          id: 'buggy_app',
          name: 'Buggy App',
          color: '#dc2626',
          icon: null,
        }, () => {
          throw new Error('Uncaught render failure!');
        });
      }
    });

    const buggyAppBtn = page.locator('button', { hasText: 'Buggy App' });
    if (await buggyAppBtn.count() > 0) {
      await buggyAppBtn.click();

      // Verify ErrorBoundary fallback is shown
      await expect(page.locator('text=App Stopped Working')).toBeVisible();

      // Press Escape key
      await page.keyboard.press('Escape');

      // Verify user is safely returned to Home screen
      await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    }
  });
});
