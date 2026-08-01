import { test, expect } from '@playwright/test';

/**
 * The Administration app is hidden from players without an admin ace.
 *
 * Worth stating plainly: this only checks the *launcher*. Hiding an icon is not a
 * permission — the report queue and every resolve action are gated again server-side,
 * because a NUI request is not proof of intent. `gphonecharge` already shipped once
 * with its gate in the wrong place, and hiding a button would not have saved it.
 *
 * A browser has no ace list and no server to ask, so it stands in as admin. That is why
 * the app is visible here at all.
 */

test.describe('Administration app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('appears on the home screen for an admin', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Administration/i })).toBeVisible();
  });

  test('shows the pending report queue', async ({ page }) => {
    await page
      .getByRole('button', { name: /Administration/i })
      .first()
      .click();
    await expect(page.locator('h1', { hasText: 'Administration' })).toBeVisible();

    // The preview is captured when the report is filed, so the queue still says what
    // was reported even once the content is gone.
    await expect(page.getByText('you are going to regret that')).toBeVisible();
    await expect(page.getByText('Harassment')).toBeVisible();
  });

  test('hiding content asks first, then clears the report', async ({ page }) => {
    await page
      .getByRole('button', { name: /Administration/i })
      .first()
      .click();

    await page.getByRole('button', { name: 'Hide content' }).click();
    await expect(page.getByText('Hide this content?')).toBeVisible();
    await page.getByRole('button', { name: 'Hide', exact: true }).click();

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
});
