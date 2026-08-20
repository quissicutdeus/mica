import { test, expect } from '@playwright/test';
import { seedHomeGrid } from '../support/homeGrid';

test.describe('Calculator App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Calculator has to already be placed
    // there for this spec's click-by-name pattern to have anything to click.
    await seedHomeGrid(page, ['calculator']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Calculator' }).first().click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
  });

  test('performs basic addition: 7 + 8 = 15', async ({ page }) => {
    const btn7 = page.locator('button', { hasText: /^7$/ }).first();
    const btnPlus = page.locator('button', { hasText: /^\+$/ }).first();
    const btn8 = page.locator('button', { hasText: /^8$/ }).first();
    const btnEquals = page.locator('button', { hasText: /^=$/ }).first();

    await btn7.click();
    await btnPlus.click();
    await btn8.click();
    await btnEquals.click();

    const display = page.locator('.break-all');
    await expect(display).toHaveText('15');
  });

  test('clears display when C is pressed', async ({ page }) => {
    const btn9 = page.locator('button', { hasText: /^9$/ }).first();
    const btnC = page.locator('button', { hasText: /^C$/ }).first();

    await btn9.click();
    await btnC.click();

    const display = page.locator('.break-all');
    await expect(display).toHaveText('0');
  });

  test('performs multiplication: 5 × 4 = 20', async ({ page }) => {
    const btn5 = page.locator('button', { hasText: /^5$/ }).first();
    const btnMult = page.locator('button', { hasText: /^×$/ }).first();
    const btn4 = page.locator('button', { hasText: /^4$/ }).first();
    const btnEquals = page.locator('button', { hasText: /^=$/ }).first();

    await btn5.click();
    await btnMult.click();
    await btn4.click();
    await btnEquals.click();

    const display = page.locator('.break-all');
    await expect(display).toHaveText('20');
  });
});
