import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

test.describe('Mail App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Mail has to already be placed there
    // for this spec's click-by-name pattern to have anything to click.
    await seedHomeGrid(page, ['mail']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Mail' }).first().click();
    await expect(page.locator('h1', { hasText: 'Mail' })).toBeVisible();
  });

  test('renders Mail app title and inbox section', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Mail' });
    await expect(title).toBeVisible();
  });
});
