import { test, expect } from '../support/test';
import {
  bootWithStore,
  homeButton,
  installFromStore,
  openStore,
  switchTo,
  uninstallFromStore
} from '../support/deviceStore';

/**
 * A tablet keeps installs of its own (MICA-264), and the Store is on it as a two-pane root.
 * The phone's `apps/store.spec.ts` covers the phone Store; this is the device axis: where an
 * install lands, where it does not, and what the tablet's Store refuses to offer.
 */
test.describe('Store on the tablet', () => {
  test('an install on the tablet is on the tablet and not on the phone', async ({ page }) => {
    await bootWithStore(page, 'tablet', { phone: ['notes'], tablet: ['notes'] });
    await expect(homeButton(page, /Notes/)).toHaveCount(0);

    await installFromStore(page, 'Notes');
    await expect(homeButton(page, /Notes/)).toBeVisible();

    await switchTo(page, 'phone');
    await expect(homeButton(page, /Notes/)).toHaveCount(0);

    // And back: the tablet's install was not lost by looking at the phone.
    await switchTo(page, 'tablet');
    await expect(homeButton(page, /Notes/)).toBeVisible();
  });

  test('an install on the phone is not on the tablet', async ({ page }) => {
    await bootWithStore(page, 'phone', { phone: ['notes'], tablet: ['notes'] });
    await installFromStore(page, 'Notes');
    await expect(homeButton(page, /Notes/)).toBeVisible();

    await switchTo(page, 'tablet');
    await expect(homeButton(page, /Notes/)).toHaveCount(0);
  });

  test('uninstalling on the tablet leaves the phone install alone', async ({ page }) => {
    await bootWithStore(page, 'phone', { phone: ['notes'], tablet: ['notes'] });
    await installFromStore(page, 'Notes');
    await switchTo(page, 'tablet');
    await installFromStore(page, 'Notes');
    await expect(homeButton(page, /Notes/)).toBeVisible();

    await uninstallFromStore(page, 'Notes');
    await expect(homeButton(page, /Notes/)).toHaveCount(0);

    await switchTo(page, 'phone');
    await expect(homeButton(page, /Notes/)).toBeVisible();
  });

  test('marks a phone-only add-on unavailable, with Install disabled', async ({ page }) => {
    await bootWithStore(page, 'tablet');
    await openStore(page);

    const row = page.locator('[data-testid="app-row"]', { hasText: 'Snek' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('app-unavailable')).toHaveText('Not available on this device.');
    await expect(row.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  });

  test('shows the same add-on installable on the phone', async ({ page }) => {
    // The control for the test above: without it, "Install is disabled" would pass for any
    // Store whose Snek row is disabled for some other reason.
    await bootWithStore(page, 'phone');
    await openStore(page);
    const row = page.locator('[data-testid="app-row"]', { hasText: 'Snek' });
    await expect(row.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
    await expect(row.getByTestId('app-unavailable')).toHaveCount(0);
  });

  test('is two panes: an empty detail pane, filled by selecting a row', async ({ page }) => {
    await bootWithStore(page, 'tablet');
    await openStore(page);

    const detail = page.getByTestId('store-detail');
    await expect(detail.getByText('Select an app')).toBeVisible();

    await page
      .locator('[data-testid="app-row"]', { hasText: 'Notes' })
      .locator('button')
      .first()
      .click();
    await expect(detail.getByText('Select an app')).toHaveCount(0);
    await expect(detail.getByRole('heading', { name: 'Notes' })).toBeVisible();
    // The list stays on screen beside it: that is what two panes means.
    await expect(page.locator('[data-testid="app-row"]', { hasText: 'Notes' })).toBeVisible();
  });
});
