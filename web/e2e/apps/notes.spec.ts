import { test, expect } from '@playwright/test';

test.describe('Notes App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Install Notes from the Store.
    //
    // Scoped to the Notes card. This used to be `.last()` with the note "Notes is last
    // catalog app", which was true only while Notes happened to sort last: the catalogue is
    // ordered by name and derived from whatever add-ons exist, so the next add-on named
    // after "Notes" silently installed *that* instead and every assertion below timed out
    // on an app that was never installed.
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page
      .locator('div.rounded-xl', { hasText: 'Notes' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Back to Home']").click();

    // Role-based, so the backgrounded Store's own catalogue row — still in the DOM, but
    // `inert` — is not what gets clicked.
    await page.getByRole('button', { name: /Notes/ }).click();
    await expect(page.locator('h1', { hasText: 'Notes' })).toBeVisible();
  });

  test('renders Notes screen title and action buttons', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Notes' });
    await expect(title).toBeVisible();
  });
});
