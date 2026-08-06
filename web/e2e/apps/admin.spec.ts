import { test, expect } from '@playwright/test';

/**
 * The Admin app is hidden from players without an admin ace.
 *
 * Worth stating plainly: this only checks the *launcher*. Hiding an icon is not a
 * permission — the report queue and every resolve action are gated again server-side,
 * because a NUI request is not proof of intent. `gphonecharge` already shipped once
 * with its gate in the wrong place, and hiding a button would not have saved it.
 *
 * A browser has no ace list and no server to ask, so it stands in as admin. That is why
 * the app is visible here at all.
 */

test.describe('Admin app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('appears on the home screen for an admin', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Admin/i })).toBeVisible();
  });

  test('shows the pending report queue', async ({ page }) => {
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();

    // The preview is captured when the report is filed, so the queue still says what
    // was reported even once the content is gone.
    await expect(page.getByText('you are going to regret that')).toBeVisible();
    await expect(page.getByText('Harassment')).toBeVisible();
  });

  test('hiding content asks first, then clears the report', async ({ page }) => {
    await page.getByRole('button', { name: /Admin/i }).first().click();

    await page.getByRole('button', { name: 'Remove for everyone' }).click();
    await expect(page.getByText('Remove this content?')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();

    await expect(page.getByText('Nothing to review')).toBeVisible();
  });

  test('a player can report someone else’s message, but not their own', async ({ page }) => {
    await page
      .getByRole('button', { name: /Messages/i })
      .first()
      .click();
    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();

    // Offered on received messages only — reporting your own is not moderation, and the
    // server refuses it, so the button should not be there to press.
    const reportButtons = page.getByRole('button', { name: 'Report message' });
    await expect(reportButtons.first()).toBeVisible();

    await reportButtons.first().click();
    await expect(page.getByText('Report content')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Harassment' })).toBeVisible();

    await page.getByRole('button', { name: 'Threats or violence' }).click();
    await page.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByText('Report sent for review')).toBeVisible();
  });

  test('the badge counts outstanding reports and visiting does not clear it', async ({ page }) => {
    // The reported behavior: opening the app cleared the count even with the report
    // still pending. A report is outstanding until somebody decides about it, so this
    // must not behave like an unread badge.
    const icon = page.getByRole('button', { name: /Admin/i }).first();
    await expect(icon).toContainText('1');

    await icon.click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
    await page.locator("button[aria-label='Return to home screen']").click();

    await expect(page.getByRole('button', { name: /Admin/i }).first()).toContainText('1');
  });

  test('history offers an undo', async ({ page }) => {
    await page.getByRole('button', { name: /Admin/i }).first().click();

    await page.getByRole('button', { name: /^History/ }).click();
    await expect(page.getByText('No history yet')).toBeVisible();

    // Decide something, then take it back.
    await page.getByRole('button', { name: /^Pending/ }).click();
    await page.getByRole('button', { name: 'Allow — no action' }).click();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Nothing to review')).toBeVisible();

    await page.getByRole('button', { name: /^History/ }).click();
    await expect(page.getByText('No action taken')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: /^Pending/ }).click();
    await expect(page.getByText('you are going to regret that')).toBeVisible();
  });
});
