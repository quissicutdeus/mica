import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

test.describe('Bank App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Bank has to already be placed there
    // for this spec's click-by-name pattern to have anything to click.
    await seedHomeGrid(page, ['bank']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Bank' }).first().click();
    await expect(page.locator('h1', { hasText: 'Bank' })).toBeVisible();
  });

  test('renders Bank screen title and recent transactions section', async ({ page }) => {
    // By role, not by tag. This read `h3` and broke when the heading became `h2` — the
    // level was wrong (`Screen` renders the only `h1`, so the first heading under it is
    // `h2`) and axe's `heading-order` is what said so, MICA-109. What the test means is
    // "the section is announced as a heading", and that is what `getByRole` asserts;
    // pinning the level here would make the next correction break it again.
    await expect(page.getByRole('heading', { name: 'Recent Transactions' })).toBeVisible();
  });

  /**
   * The whole solo-testable path from MICA-56: the mock registry's `sendMoney`
   * plays the same state machine `server/services/Bank.ts` does (self-transfer refused,
   * an amount over the cap refused, everything else settles), so this is real coverage
   * of the flow, not a UI-only stub.
   */
  test.describe('Send Money', () => {
    test('sends money, updates the balance, and records a transaction', async ({ page }) => {
      await expect(page.getByText('$12,450.00')).toBeVisible();

      await page.getByText('Send Money').click();
      await page.getByPlaceholder("Recipient's phone number").fill('555-0199');
      await page.getByPlaceholder('Amount').fill('100');
      await page.getByText('Send', { exact: true }).click();

      // The modal closes on success and the balance re-fetch reflects the real deduction.
      await expect(page.getByPlaceholder("Recipient's phone number")).toBeHidden();
      await expect(page.getByText('$12,350.00')).toBeVisible();
      await expect(page.getByText('Sent to 555-0199')).toBeVisible();
    });

    test('refuses a self-transfer with the specific reason, not a generic error', async ({
      page
    }) => {
      await page.getByText('Send Money').click();
      // The mock's own number, mirroring `getPhoneNumber`'s '867-5309' — the same
      // same_player check `Payments.transfer` makes server-side.
      await page.getByPlaceholder("Recipient's phone number").fill('867-5309');
      await page.getByPlaceholder('Amount').fill('50');
      await page.getByText('Send', { exact: true }).click();

      await expect(page.getByText('You cannot send money to your own number.')).toBeVisible();
      // Refused, not just slow — the balance never moved. Exact match: the modal is
      // still open behind this refusal, and its own "Available balance: $12,450.00"
      // line contains the same figure as the CreditCard's.
      await expect(page.getByText('$12,450.00', { exact: true })).toBeVisible();
    });

    test('refuses an amount over the configured transfer cap', async ({ page }) => {
      await page.getByText('Send Money').click();
      await page.getByPlaceholder("Recipient's phone number").fill('555-0199');
      await page.getByPlaceholder('Amount').fill('999999');
      await page.getByText('Send', { exact: true }).click();

      await expect(
        page.getByText('That is more than this phone can send in a single transfer.')
      ).toBeVisible();
    });

    test('Cancel closes the sheet without sending anything', async ({ page }) => {
      await page.getByText('Send Money').click();
      await page.getByPlaceholder("Recipient's phone number").fill('555-0199');
      await page.getByPlaceholder('Amount').fill('100');
      await page.getByText('Cancel').click();

      await expect(page.getByPlaceholder("Recipient's phone number")).toBeHidden();
      await expect(page.getByText('$12,450.00')).toBeVisible();
    });
  });

  /**
   * Invoices (MICA-240). The mock registry's `invoices:pay` and `invoices:decline` play the
   * server's state machine — a row leaves `active`, the reply carries the re-read open
   * list, and paying debits the balance and writes a transaction — so every assertion here
   * reads back a state change, not the fixture as shipped. The fixture is module state in
   * the bundle, so each test's fresh `page.goto` starts from the same two open rows.
   */
  test.describe('Invoices', () => {
    const sections = (page: Page) => page.getByRole('navigation', { name: 'Bank sections' });
    const invoicesTab = (page: Page) => sections(page).getByRole('button', { name: 'Invoices' });
    const accountTab = (page: Page) => sections(page).getByRole('button', { name: 'Account' });
    // The badge is the one number inside the tab; with nothing open it is not rendered at
    // all, so "gone" is a count of zero rather than a text of "0".
    const badge = (page: Page) => invoicesTab(page).locator('.rounded-full');
    // A row is the card carrying the biller's name; its buttons are found inside it so a
    // Pay tap can never land on the other invoice.
    const row = (page: Page, biller: string) =>
      page.locator('.rounded-box', { has: page.getByText(biller, { exact: true }) });
    // The list under the heading, and its first card: "at the top" is a position, and
    // `getByText` alone would pass with the row anywhere in the list. Scoped to the list
    // rather than the page because the success toast names the biller too, and a page-wide
    // "no Pillbox Medical" would sit waiting on the toast's own dismissal timer.
    const transactions = (page: Page) =>
      page
        .getByRole('heading', { name: 'Recent Transactions' })
        .locator('xpath=following-sibling::div[1]');
    const topTransaction = (page: Page) => transactions(page).locator('xpath=div[1]');

    test('badges the open count and lists only the open invoices', async ({ page }) => {
      await expect(badge(page)).toHaveText('2');

      await invoicesTab(page).click();
      await expect(invoicesTab(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('heading', { name: 'Open Invoices' })).toBeVisible();

      await expect(row(page, 'Los Santos Customs')).toContainText('Engine rebuild');
      await expect(row(page, 'Los Santos Customs')).toContainText('$450.00');
      await expect(row(page, 'Pillbox Medical')).toContainText('$120.00');
      // Paid already in the fixture: the list is the open ones only, the way `findOpen`
      // reads it on the server.
      await expect(page.getByText('Downtown Cab Co.')).toHaveCount(0);
    });

    test('paying removes the row, drops the badge, and moves the money', async ({ page }) => {
      await invoicesTab(page).click();
      await row(page, 'Los Santos Customs').getByRole('button', { name: 'Pay' }).click();

      await expect(row(page, 'Los Santos Customs')).toHaveCount(0);
      await expect(row(page, 'Pillbox Medical')).toBeVisible();
      await expect(badge(page)).toHaveText('1');

      // Back on Account the card was re-read, not patched: the balance is the mock's
      // debit and the transaction it wrote sits at the top of the list.
      await accountTab(page).click();
      await expect(page.getByText('$12,000.00')).toBeVisible();
      await expect(page.getByText('$12,450.00')).toHaveCount(0);
      await expect(topTransaction(page)).toContainText('Paid Los Santos Customs');
      await expect(topTransaction(page)).toContainText('-$450.00');
    });

    test('declining removes the row and leaves the balance alone', async ({ page }) => {
      await invoicesTab(page).click();
      await row(page, 'Pillbox Medical').getByRole('button', { name: 'Decline' }).click();

      await expect(row(page, 'Pillbox Medical')).toHaveCount(0);
      await expect(row(page, 'Los Santos Customs')).toBeVisible();
      await expect(badge(page)).toHaveText('1');

      await accountTab(page).click();
      await expect(page.getByText('$12,450.00')).toBeVisible();
      await expect(transactions(page)).not.toContainText('Pillbox Medical');
    });

    test('shows the empty state once every invoice is settled', async ({ page }) => {
      await invoicesTab(page).click();
      await row(page, 'Los Santos Customs').getByRole('button', { name: 'Pay' }).click();
      await expect(row(page, 'Los Santos Customs')).toHaveCount(0);
      await row(page, 'Pillbox Medical').getByRole('button', { name: 'Decline' }).click();
      await expect(row(page, 'Pillbox Medical')).toHaveCount(0);

      await expect(page.getByText('No open invoices')).toBeVisible();
      await expect(page.getByText('Nothing is waiting to be paid.')).toBeVisible();
      await expect(badge(page)).toHaveCount(0);
    });
  });
});
