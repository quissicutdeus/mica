import { test, expect } from '@playwright/test';
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
});
