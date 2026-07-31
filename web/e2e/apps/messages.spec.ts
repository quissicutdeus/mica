import { test, expect } from '@playwright/test';

test.describe('Messages App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Messages' }).first().click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();
  });

  test('renders Messages header and conversational UI', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Messages' });
    await expect(title).toBeVisible();
  });

  test('virtualizes message list and lazy-loads older messages on multiple scroll-ups', async ({
    page
  }) => {
    // Select first conversation ListItem by role="button" with force click
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    // Check header updates to contact name
    const headerTitle = page.locator('button', { hasText: 'Trevor Philips' }).first();
    await expect(headerTitle).toBeVisible();

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    // Verify initially only 50 messages are rendered in DOM out of 200 (150 hidden)
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).toBeVisible();
    await expect(messagesContainer.locator('button', { hasText: '150 hidden' })).toBeVisible();

    // --- First Scroll Up / Load Older Batch ---
    const loadBtn1 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn1.dispatchEvent('click');
    await expect(messagesContainer.locator('button', { hasText: '100 hidden' })).toBeVisible();

    // --- Second Scroll Up / Load Older Batch ---
    const loadBtn2 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn2.dispatchEvent('click');
    await expect(messagesContainer.locator('button', { hasText: '50 hidden' })).toBeVisible();

    // --- Third Scroll Up / Load Remaining Batch ---
    const loadBtn3 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn3.dispatchEvent('click');

    // Now all 200 messages are loaded and hidden count button is gone
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).not.toBeVisible();
  });
});
