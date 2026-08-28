import { test, expect } from '@playwright/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, installAddOn } from '../support/addon';

test.describe('Notes App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Store has to already be placed there
    // to reach the install path below.
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    // Install Notes from the Store, through the shared helper — which is scoped to the
    // Notes card. This used to be `.last()` with the note "Notes is last catalog app",
    // which was true only while Notes happened to sort last: the catalog is ordered by
    // name and derived from whatever add-ons exist, so the next add-on named after "Notes"
    // silently installed *that* instead and every assertion below timed out on an app that
    // was never installed.
    await installAddOn(page, 'Notes');

    // Role-based, so the backgrounded Store's own catalog row — still in the DOM, but
    // `inert` — is not what gets clicked.
    await page.getByRole('button', { name: /Notes/ }).click();
    await expect(addOnFrame(page, 'notes').locator('h1', { hasText: 'Notes' })).toBeVisible();
  });

  test('renders Notes screen title and action buttons', async ({ page }) => {
    const title = addOnFrame(page, 'notes').locator('h1', { hasText: 'Notes' });
    await expect(title).toBeVisible();
  });
});
