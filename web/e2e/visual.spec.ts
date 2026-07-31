import { test, expect } from '@playwright/test';

test.describe('Visual Snapshot Regression Suite', () => {
  test('matches phone frame and home screen launcher visual snapshot', async ({ page }) => {
    await page.goto('/');

    const mainElement = page.locator('main');
    await expect(mainElement).toBeVisible();

    // Verify visual snapshot of phone UI layout
    await expect(mainElement).toHaveScreenshot('home-screen.png', {
      maxDiffPixelRatio: 0.05
    });
  });
});
