import { test, expect } from '@playwright/test';
import { seedHomeGrid } from '../support/homeGrid';

test.describe('Bank App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Bank has to already be placed there
    // for this spec's click-by-name pattern to have anything to click.
    await seedHomeGrid(page, ['bank']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Bank' }).first().click();
    await expect(page.locator('h1', { hasText: 'Bank' })).toBeVisible();
  });

  test('renders Bank screen title and recent transactions section', async ({ page }) => {
    const recentTxHeading = page.locator('h3', { hasText: 'Recent Transactions' });
    await expect(recentTxHeading).toBeVisible();
  });
});
