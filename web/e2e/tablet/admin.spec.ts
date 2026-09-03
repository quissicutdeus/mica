import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';

/**
 * Admin on the tablet is two panes (MICA-261): the queue on the left, the selected
 * report on the right, and every decision is taken from the detail pane. The phone's
 * `apps/admin.spec.ts` covers the same decisions on the single-column root.
 */
test.describe('Admin on the tablet', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['admin'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settledFrameBox(page, 'tablet');
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
  });

  test('selects the first pending report and shows it on the right', async ({ page }) => {
    const detail = page.getByTestId('admin-detail');
    await expect(detail.getByText('you are going to regret that')).toBeVisible();
    await expect(detail.getByText('Harassment')).toBeVisible();
    // The row, not the tab: `SegmentedControl`'s selected tab is `aria-pressed` too.
    await expect(page.getByRole('button', { pressed: true, name: /Harassment/ })).toHaveCount(1);
  });

  test('removes from the detail pane, then undoes it from history', async ({ page }) => {
    const detail = page.getByTestId('admin-detail');
    await detail.getByRole('button', { name: 'Remove for everyone' }).click();
    await expect(page.getByText('Remove this content?')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Nothing to review')).toBeVisible();

    await page.getByRole('button', { name: /^History/ }).click();
    await expect(page.getByText('Content removed').first()).toBeVisible();
    await detail.getByRole('button', { name: 'Undo' }).click();

    await page.getByRole('button', { name: /^Pending/ }).click();
    await expect(detail.getByText('you are going to regret that')).toBeVisible();
  });

  test('allows from the detail pane', async ({ page }) => {
    const detail = page.getByTestId('admin-detail');
    await detail.getByRole('button', { name: 'Allow — no action' }).click();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Nothing to review')).toBeVisible();
  });
});
