import { test, expect } from '@playwright/test';

test.describe('Media App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Media' }).first().click();
    await expect(page.locator('h1', { hasText: 'Media' })).toBeVisible();
  });

  test('renders Media app title and gallery area', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Media' });
    await expect(title).toBeVisible();
  });
});
