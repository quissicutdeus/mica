import { test, expect } from '@playwright/test';

/**
 * The percentage the volume HUD is showing.
 *
 * Read off a testid rather than any `NN%` on screen — the Sound pane's step-size buttons
 * are also labeled that way, and matching text picked one of those instead.
 */
const hudPercent = async (page: import('@playwright/test').Page): Promise<number> => {
  const hud = page.getByTestId('volume-hud-percent');
  await expect(hud).toBeVisible();
  const text = await hud.textContent();
  return Number((text ?? '').trim().replace('%', ''));
};

test.describe('Volume Buttons E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('a press moves the volume by 5% by default', async ({ page }) => {
    // The store starts at 50%.
    await page.locator("button[aria-label='Volume Up']").click();
    expect(await hudPercent(page)).toBe(55);

    await page.locator("button[aria-label='Volume Down']").click();
    await page.locator("button[aria-label='Volume Down']").click();
    expect(await hudPercent(page)).toBe(45);
  });

  test('the step size is configurable from Settings > Sound and applies immediately', async ({
    page
  }) => {
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.getByRole('button', { name: new RegExp('^Sound\\b') }).click();
    await expect(page.locator('h1', { hasText: 'Sound' })).toBeVisible();

    await page.locator('button[aria-pressed]', { hasText: '20%' }).click();
    await expect(page.locator("button[aria-pressed='true']", { hasText: '20%' })).toBeVisible();

    await page.locator("button[aria-label='Volume Up']").click();
    expect(await hudPercent(page)).toBe(70);
  });

  test('the step size survives a reload', async ({ page }) => {
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.getByRole('button', { name: new RegExp('^Sound\\b') }).click();
    await page.locator('button[aria-pressed]', { hasText: '10%' }).click();

    await page.reload();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.getByRole('button', { name: new RegExp('^Sound\\b') }).click();
    await expect(page.locator("button[aria-pressed='true']", { hasText: '10%' })).toBeVisible();

    await page.locator("button[aria-label='Volume Up']").click();
    expect(await hudPercent(page)).toBe(60);
  });
});
