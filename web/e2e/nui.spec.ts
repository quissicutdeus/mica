import { test, expect } from '@playwright/test';

test.describe('FiveM NUI Phone Interface', () => {
  test('renders phone container and initializes in browser mode', async ({ page }) => {
    await page.goto('/');

    // Main phone wrapper container should be visible in browser mode
    const mainElement = page.locator('main');
    await expect(mainElement).toBeVisible();

    // Verify phone frame container element. By test id rather than by its height class:
    // the frame's size is now a `style` attribute driven by `state/display.ts`, because
    // the phone is scaled to fit the window (`display.spec.ts` covers that).
    await expect(page.getByTestId('phone-frame')).toBeVisible();
  });

  test('handles NUI window message events', async ({ page }) => {
    await page.goto('/');

    // Dispatch custom setVisible false message to hide phone
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: false }, '*');
    });

    const mainElement = page.locator('main');
    await expect(mainElement).toBeHidden();

    // Dispatch setVisible true to show phone again
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: true }, '*');
    });

    await expect(mainElement).toBeVisible();
  });
});
