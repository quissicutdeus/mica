import { test, expect } from '@playwright/test';

test.describe('Keyboard Shortcuts E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('the Calculator no longer handles Escape itself', async ({ page }) => {
    // Escape used to fire twice: the calculator's own window handler cleared the display
    // *and* the shell navigated home, because neither stopped the other. Rebinding Back
    // off Escape is what makes that observable — with Escape still bound, the shell
    // navigates away and App.svelte re-keys the app, so a cleared display and a
    // remounted one look identical.
    await page.evaluate(() => {
      localStorage.setItem('gphone:settings:keybinds', JSON.stringify({ back: 'q' }));
    });
    await page.reload();

    await page.locator('button', { hasText: 'Calculator' }).first().click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    await page.locator('button', { hasText: '7' }).first().click();
    const display = page.locator('.text-6xl');
    await expect(display).toHaveText('7');

    await page.keyboard.press('Escape');
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
    await expect(display).toHaveText('7');

    // The rebound key still does the shell's job.
    await page.keyboard.press('q');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('a bound key typed into the message composer is text, not a shortcut', async ({ page }) => {
    await page.locator('button', { hasText: 'Messages' }).first().click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();

    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();

    const composer = page.locator('textarea[placeholder="Message"]');
    await expect(composer).toBeVisible();
    await composer.click();

    // Rebind Back onto a plain letter first, so the press is unambiguously one the
    // dispatcher would otherwise claim.
    await page.evaluate(() => {
      localStorage.setItem('gphone:settings:keybinds', JSON.stringify({ back: 'q' }));
    });
    await page.reload();

    await page.locator('button', { hasText: 'Messages' }).first().click();
    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();
    const composerAfter = page.locator('textarea[placeholder="Message"]');
    await composerAfter.click();
    await composerAfter.type('qq');

    // Both characters landed, and the shell did not navigate away.
    await expect(composerAfter).toHaveValue('qq');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toHaveCount(0);
  });

  test('a rebind set in Settings survives a UI reload', async ({ page }) => {
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Shortcuts' })).toBeVisible();

    const backRow = page.locator('button', { hasText: 'Back / Close' });
    await expect(backRow).toBeVisible();
    await expect(backRow).toContainText('Escape');

    await backRow.click();
    await expect(page.locator('text=Press a key…')).toBeVisible();
    await page.keyboard.press('q');
    await expect(backRow).toContainText('Q');

    await page.reload();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.locator('button', { hasText: 'Back / Close' })).toContainText('Q');

    // And the new key actually drives navigation, not just the label. Settings claims
    // `back` while mounted, so the first press steps up to the hub.
    await page.keyboard.press('q');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    await page.keyboard.press('q');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });
});
