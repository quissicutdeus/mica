import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';

/**
 * Edit history (MICA-430): staff open a reported row's earlier versions from the report.
 *
 * The browser mock seeds three versions of the seeded report's message
 * (`web/src/nui/mocks/services/reports.ts`), answered oldest first as the server answers
 * them, so the order asserted here is the store's reversal, not the mock's. One of them
 * carries markup, which must reach the screen as text: old text is another player's words.
 *
 * What this cannot prove: that the server's `reports:versions` answers this shape, that it
 * is admin-gated, or that a sealed value opens in game — the mock answers by action name.
 */

const openHistory = async (page: Page) => {
  await page.getByRole('button', { name: 'Edit history' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Edit history' });
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('Admin edit history', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['admin']);
    await page.goto('/');
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
  });

  test('lists the reported message’s earlier versions, newest first', async ({ page }) => {
    const dialog = await openHistory(page);
    const versions = dialog.getByTestId('admin-version');
    await expect(versions).toHaveCount(3);

    await expect(versions.nth(0)).toContainText('you are really going to regret that');
    await expect(versions.nth(0)).toContainText('Edited');
    await expect(versions.nth(0)).toContainText('Changed by its owner');

    // A value no loaded key opens is said in words, and a server write is not the owner's.
    await expect(versions.nth(1)).toContainText('Phone handed over');
    await expect(versions.nth(1)).toContainText('(sealed — no loaded key opens it)');
    await expect(versions.nth(1)).toContainText('Changed by the server or staff');

    await expect(versions.nth(2)).toContainText('I know where you park.');
  });

  test('shows old text as text, never as markup', async ({ page }) => {
    const dialog = await openHistory(page);
    const oldest = dialog.getByTestId('admin-version').nth(2);
    await expect(oldest).toContainText('<b>You are going to regret that.</b>');
    await expect(oldest.locator('b')).toHaveCount(0);
  });

  test('Back closes the history rather than leaving the app', async ({ page }) => {
    // Backspace is the shell's `back` action; the dialog is a `useAppLevels` rung, so the
    // first press closes it and the queue is still there behind it.
    await openHistory(page);
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('dialog', { name: 'Edit history' })).toHaveCount(0);
    await expect(page.getByText('you are going to regret that')).toBeVisible();
  });

  test('closes from its own button', async ({ page }) => {
    const dialog = await openHistory(page);
    await dialog.getByRole('button', { name: 'Close edit history' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit history' })).toHaveCount(0);
  });
});

test.describe('Admin edit history on the tablet', () => {
  test('opens from the detail pane', async ({ page }) => {
    await seedHomeGrid(page, ['admin'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settledFrameBox(page, 'tablet');
    await page.getByRole('button', { name: /Admin/i }).first().click();

    await page.getByTestId('admin-detail').getByRole('button', { name: 'Edit history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit history' });
    await expect(dialog.getByTestId('admin-version')).toHaveCount(3);
  });
});
