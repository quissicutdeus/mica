import { test, expect } from '../support/test';
import AxeBuilder from '@axe-core/playwright';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * MICA-169: on a server with no money the Store still lists Hodlr, greyed, with the reason.
 * `?mica_no_money=1` makes the browser mock answer `shell:capabilities` like a standalone
 * server does.
 */
test.describe('Store on a server without money', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['store']);
    await page.goto('/?mica_no_money=1');
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
  });

  test('lists Hodlr as unavailable, with the reason and no working Install', async ({ page }) => {
    const row = page.locator('[data-testid="app-row"]', { hasText: 'Hodlr' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('app-unavailable')).toHaveText('Needs a server with money');
    await expect(row.getByRole('button', { name: 'Install' })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Install' })).toHaveCSS('cursor', 'not-allowed');
    // An add-on with no requirement is unaffected.
    const notes = page.locator('[data-testid="app-row"]', { hasText: 'Notes' });
    await expect(notes.getByRole('button', { name: 'Install' })).toBeEnabled();
  });

  test('the details page says the same and disables Install', async ({ page }) => {
    await page
      .locator('[data-testid="app-row"]', { hasText: 'Hodlr' })
      .locator('button')
      .first()
      .click();
    await expect(page.getByTestId('app-unavailable')).toHaveText('Needs a server with money');
    await expect(page.getByRole('button', { name: 'Install Application' })).toBeDisabled();
  });

  test('the greyed row has no accessibility violations', async ({ page }) => {
    await expect(page.getByTestId('app-unavailable').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[data-testid="app-row"]').analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
