import { test, expect } from '@playwright/test';

test.describe('Photos App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Photos' }).first().click();
    await expect(page.locator('h1', { hasText: 'Photos' })).toBeVisible();
  });

  test('renders Photos app title and gallery area', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Photos' });
    await expect(title).toBeVisible();
  });
});
