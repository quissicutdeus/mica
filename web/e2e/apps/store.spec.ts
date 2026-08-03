import { test, expect } from '@playwright/test';

test.describe('Store E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
  });

  /**
   * These used to run against Crypto Tracker, one of four invented catalogue entries with no
   * code behind them. They now run against Notes — a real in-repo add-on — which is the only
   * thing that makes the install assertion below mean anything: installing a fiction
   * registered a placeholder screen and still reported "installed successfully".
   *
   * Card locators rather than `text=Notes`, because `text=` matches substrings
   * case-insensitively and Notes' own description ends in "personal notes" — a bare text
   * match hits the name and the description and trips strict mode.
   */
  const catalogCard = (page: import('@playwright/test').Page, name: string) =>
    page.locator('div.rounded-xl', { hasText: name });

  test('renders tabs and catalog apps correctly', async ({ page }) => {
    await expect(page.locator('button', { hasText: 'Store Catalog' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Installed (' })).toBeVisible();
    await expect(catalogCard(page, 'Notes')).toBeVisible();
  });

  test('opens app permission and details inspector modal', async ({ page }) => {
    await catalogCard(page, 'Notes').locator('button').first().click();

    await expect(page.locator('h3', { hasText: 'Notes' })).toBeVisible();
    await expect(page.locator('text=Local Storage')).toBeVisible();
    // Exact: the details page also carries a "Community Add-on" type badge, and an
    // unquoted `text=` match is a case-insensitive substring, so it hits both.
    await expect(page.getByText('Community', { exact: true })).toBeVisible();
  });

  test('installs community add-on app and verifies icon appears on home screen', async ({
    page
  }) => {
    await catalogCard(page, 'Notes').locator('button', { hasText: 'Install' }).click();

    // Verify toast or button state updates
    await expect(page.locator('text=installed successfully')).toBeVisible();

    // Go back home
    await page.locator("button[aria-label='Back to Home']").click();

    // Verify the new Notes icon exists on the home screen. Role-based, because apps stay
    // resident once opened: the Store's own catalogue row is still in the DOM behind this
    // one, and only `inert` on the backgrounded app keeps it out of the accessibility tree.
    await expect(page.getByRole('button', { name: /Notes/ })).toBeVisible();
  });

  test('displays installed system vs add-on filter and sort order in Installed tab', async ({
    page
  }) => {
    await page.locator('button', { hasText: 'Installed (' }).click();

    await expect(page.locator('button', { hasText: 'System' }).first()).toBeVisible();
    await expect(page.locator('button', { hasText: 'Add-ons' }).first()).toBeVisible();
    await expect(page.locator("select[aria-label='Sort Installed Apps']")).toBeVisible();

    // System apps should display "System" badge
    await expect(page.locator('text=System').first()).toBeVisible();

    // Click first installed app item button to open details modal and verify Installed Date field
    const firstInstalledAppCard = page.locator('div.grid button').first();
    await firstInstalledAppCard.dispatchEvent('click');
    await expect(page.locator('text=Installed Date')).toBeVisible();
  });
});
