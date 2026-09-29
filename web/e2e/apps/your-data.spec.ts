import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';

/**
 * Settings > Privacy > Your data (MICA-168): see what micaOS holds, copy it, delete it.
 *
 * The browser mock stands in for the server here (`privacy:export` / `privacy:delete` in
 * `web/src/nui/mocks/registry.ts`), and it checks the confirmation word the way the server
 * does. What this proves is the pane's wiring to the two actions and what it does with
 * their answers; that the server really refuses a wrong word and really deletes is
 * `server/__tests__`, and none of it says anything about the game or CEF.
 *
 * The failed-load, partial and uncountable-`kept` states are not reachable through the
 * mock and are pinned in `panes/YourData.test.ts`.
 */

const openYourData = async (page: Page) => {
  await page.locator('button', { hasText: 'About' }).first().click();
  await page.locator('button', { hasText: 'Privacy' }).first().click();
  await page.locator('button', { hasText: 'Your data' }).first().click();
  await expect(page.locator('h1', { hasText: 'Your data' })).toBeVisible();
};

test.describe('Your data', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['settings']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    await openYourData(page);
  });

  test('shows the data by category with counts, and a truncated category says so', async ({
    page
  }) => {
    const notes = page.getByTestId('your-data-cat-notes');
    await expect(notes).toContainText('Notes');
    await expect(notes).toContainText('2');
    const messages = page.getByTestId('your-data-cat-messages');
    await expect(messages).toContainText('Cut short: showing the first 25 rows');
    // A category the export cut for size has no rows to open, and is listed all the same.
    await expect(page.getByTestId('your-data-cat-marketplace_attachments')).toContainText(
      'Not included: export size limit'
    );
    // A withheld column is named, not silently absent.
    await expect(page.getByTestId('your-data-cat-media')).toContainText('owner_token');

    // A category opens to its rows.
    await notes.click();
    await expect(page.getByRole('textbox', { name: 'Notes, raw rows' })).toHaveValue(/Groceries/);
    await expect(notes).toHaveAttribute('aria-expanded', 'true');
  });

  test('Copy all as JSON puts the whole export on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy all as JSON' }).click();
    await expect(page.getByText('Your data was copied')).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const parsed = JSON.parse(text);
    expect(parsed.categories.map((c: { category: string }) => c.category)).toEqual([
      'notes',
      'messages',
      'media',
      'marketplace_attachments'
    ]);
    expect(parsed.categories[1].truncated).toBe('rows');
  });

  test('warns before asking for the word, refuses a wrong one, then shows removed and kept', async ({
    page
  }) => {
    await expect(page.getByText(/irreversible/)).toBeVisible();
    await expect(page.getByText(/open report is kept/)).toBeVisible();
    await expect(page.getByText(/request is logged/)).toBeVisible();

    const button = page.getByRole('button', { name: 'Delete my data' });
    // Nothing to send until something is typed.
    await expect(button).toBeDisabled();

    const word = page.getByTestId('your-data-word');
    await word.fill('delete');
    await button.click();
    await expect(page.getByTestId('your-data-error')).toContainText('not the confirmation word');
    // The refusal changed nothing: the data is still listed, the input still there.
    await expect(page.getByTestId('your-data-result')).toHaveCount(0);
    await expect(page.getByTestId('your-data-cat-notes')).toBeVisible();
    await expect(word).toHaveValue('delete');

    await word.fill('DELETE');
    await button.click();
    await expect(page.getByTestId('your-data-result')).toContainText('Your data was deleted');
    await expect(page.getByTestId('your-data-removed')).toContainText('28');
    await expect(page.getByTestId('your-data-kept')).toContainText('2');
    // No automatic refetch: the export is rate limited, so what is left is the player's call.
    await expect(page.getByTestId('your-data-categories')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reload my data' }).click();
    await expect(page.getByText('micaOS holds nothing for this character.')).toBeVisible();
  });

  test("the export is rate limited, and the pane shows the server's own message", async ({
    page
  }) => {
    // `beforeEach` opened the pane once. Two more opens use the allowance of three a minute.
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Backspace');
      await page.locator('button', { hasText: 'Your data' }).first().click();
      await expect(page.getByTestId('your-data-categories')).toBeVisible();
    }
    await page.keyboard.press('Backspace');
    await page.locator('button', { hasText: 'Your data' }).first().click();
    // The refusal says how long to wait, not just that it failed.
    await expect(page.getByTestId('your-data-load-error')).toContainText(/Try again in \d+s/);
    await expect(page.getByTestId('your-data-categories')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('Back from Your data returns to Privacy', async ({ page }) => {
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'Privacy' })).toBeVisible();
  });
});

test('Your data is reachable on the tablet too, through About > Privacy', async ({ page }) => {
  await seedHomeGrid(page, ['settings'], 'tablet');
  await gotoDevice(page, 'tablet');
  await settledFrameBox(page, 'tablet');
  await page
    .getByRole('button', { name: /Settings/i })
    .first()
    .click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: /^About/ })
    .click();
  await openYourData(page);
  await expect(page.getByTestId('your-data-cat-notes')).toBeVisible();
});
