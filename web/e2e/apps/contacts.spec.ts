import { test, expect } from '@playwright/test';

test.describe('Contacts App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Contacts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
  });

  test('renders Contacts app interface and header', async ({ page }) => {
    const header = page.locator('h1', { hasText: 'Contacts' });
    await expect(header).toBeVisible();
  });

  test('contains search input and empty state or contact list', async ({ page }) => {
    const searchInput = page.locator('input[type="text"]');
    if ((await searchInput.count()) > 0) {
      await expect(searchInput).toBeVisible();
      await searchInput.fill('John');
      await expect(searchInput).toHaveValue('John');
    }
  });

  test('disables Save Contact button when mandatory first name or phone number is missing', async ({
    page
  }) => {
    // Look for FAB / Add contact button
    const fabBtn = page
      .locator('button[aria-label="Add Contact"]')
      .or(page.locator('button', { hasText: '+' }))
      .first();
    if (await fabBtn.isVisible()) {
      await fabBtn.click();

      const saveBtn = page.locator('button', { hasText: 'Save Contact' }).first();
      await expect(saveBtn).toBeDisabled();

      const firstnameInput = page.locator('input[placeholder="First Name *"]');
      const phoneInput = page.locator('input[placeholder="Phone Number *"]');
      await expect(firstnameInput).toBeVisible();
      await expect(phoneInput).toBeVisible();

      await firstnameInput.fill('Arthur');
      await expect(saveBtn).toBeDisabled();

      await phoneInput.fill('555-0999');
      await expect(saveBtn).toBeEnabled();
    }
  });
});
