import { test, expect } from '@playwright/test';

test.describe('Settings App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  });

  test('renders Settings interface and toggles 24-hour time format', async ({ page }) => {
    const toggleSwitch = page.locator('button[aria-label="Toggle 24-hour time"]');
    await expect(toggleSwitch).toBeVisible();

    // Toggle switch on and off
    await toggleSwitch.click();
    await toggleSwitch.click();
  });

  test('displays About section with phone number, OS name, and smart versioning info', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'About' })).toBeVisible();
    await expect(page.locator('text=Phone Number')).toBeVisible();
    await expect(page.locator('text=gPhone')).toBeVisible();
    await expect(page.locator('text=555-0199')).toBeVisible();
  });
});
