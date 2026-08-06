import { test, expect } from '@playwright/test';

test.describe('Phone Dialer App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Phone' }).first().click();
    await expect(page.locator('h1', { hasText: 'Phone' })).toBeVisible();
  });

  /**
   * Keypad digits are addressed by **accessible name**, not by text content.
   *
   * `page.locator('button', { hasText: '5' }).first()` looks right and is a trap. The
   * status bar in `PhoneFrame` is itself a `<button>`, it contains the clock and the
   * battery percentage, and it comes first in the DOM — so `.first()` resolved to it
   * for any time containing the digit under test, opened the notification shade, and
   * the shade's scrim then blocked every later click. It failed at 9:59 PM and passed
   * at 10:00, which reads like a real defect and is not one.
   *
   * `getByRole(name:)` computes the accessible name, and the status bar has an explicit
   * `aria-label="Open notification shade"` — no digits in it. The keypad buttons have no
   * label, so their accessible name is their text. That is what makes the two
   * distinguishable, and it is also what the test actually means: the button *called* 5.
   *
   * Do not "simplify" these back to `hasText`.
   */
  test('dials numbers using numeric keypad and clears with backspace', async ({ page }) => {
    const btn5 = page.getByRole('button', { name: '5', exact: true });

    // Click 5 5 5
    await btn5.click();
    await btn5.click();
    await btn5.click();

    // Verify number display contains 555
    const numberDisplay = page.locator('.text-4xl');
    await expect(numberDisplay).toHaveText('555');

    // Click Backspace button
    const backspaceBtn = page.locator('button[aria-label="Backspace"]');
    await expect(backspaceBtn).toBeVisible();
    await backspaceBtn.click();

    await expect(numberDisplay).toHaveText('55');
  });

  test('initiates call and transitions to calling view controls', async ({ page }) => {
    const btn9 = page.getByRole('button', { name: '9', exact: true });
    await btn9.click();

    const callBtn = page.locator('button[aria-label="Call"]');
    await expect(callBtn).toBeVisible();
    await callBtn.click();

    // In-call view elements
    const endCallBtn = page.locator('button[aria-label="End Call"]');
    await expect(endCallBtn).toBeVisible();

    const speakerBtn = page.locator('button[aria-label="Speaker"]');
    await expect(speakerBtn).toBeVisible();
    await speakerBtn.click();

    // End call and return to idle keypad state
    await endCallBtn.click();
    await expect(callBtn).toBeVisible();
  });
});
