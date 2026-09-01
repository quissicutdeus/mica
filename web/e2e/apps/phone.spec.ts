import { test, expect, type Page } from '../support/test';

const dial = async (page: Page, digits: string) => {
  for (const digit of digits) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
};

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

  /**
   * MICA-55: the mock registry plays out a real call lifecycle on a timer — ring,
   * then connect — rather than answering `startCall` and going nowhere, which is why
   * this is reachable at all. See `registry.ts`'s `startCall`/`endCall` for the timing.
   */
  test('a dialed call connects, and hanging up logs it in Recents', async ({ page }) => {
    await dial(page, '5551234');
    await page.locator('button[aria-label="Call"]').click();

    const endCallBtn = page.locator('button[aria-label="End Call"]');
    await expect(endCallBtn).toBeVisible();
    // The mock rings for 350ms before connecting. "Dialing..." is the one status text
    // exclusive to that ring — once it's gone, the call is connected (or over).
    await expect(page.getByText('Dialing...')).toBeHidden({ timeout: 5000 });
    await expect(endCallBtn).toBeVisible();

    await endCallBtn.click();
    await expect(page.locator('button[aria-label="Call"]')).toBeVisible();

    await page.getByRole('button', { name: 'Recents' }).click();
    await expect(page.getByText('5551234')).toBeVisible();
  });

  /**
   * `server/services/Phone.ts`'s `logCallEnd` writes `outgoing` to the *caller's* own
   * log for an unanswered call, never `missed` — `missed` is exclusively what the
   * person who didn't pick up sees in theirs. An earlier draft of this test asserted
   * the wrong one; the mock was right, the assertion wasn't.
   */
  test('an unanswered outgoing call still logs, with zero duration and no error styling', async ({
    page
  }) => {
    await dial(page, '0000000');
    await page.locator('button[aria-label="Call"]').click();

    // No one ever answers this number — the mock gives up and returns the phone to
    // idle on its own, with no "End Call" click.
    await expect(page.locator('button[aria-label="Call"]')).toBeVisible({ timeout: 5000 });

    // Nothing re-fetches Recents on a call that ended by itself rather than by the
    // local End Call button — leaving and reopening Phone is the real, if imperfect,
    // way a player would see it too.
    await page.locator('button[aria-label="Go back"]').click();
    await page.locator('button', { hasText: 'Phone' }).first().click();
    await page.getByRole('button', { name: 'Recents' }).click();

    const row = page.getByText('0000000');
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/text-error/);
    await expect(page.getByText('0:00')).toBeVisible();
  });

  /**
   * The actual `missed` case: an incoming call, declined. Driven through the real
   * `window.postMessage` channel the client itself pushes `callStatus` over — the same
   * integration point `devHarness.ts`'s console helper uses — rather than a shortcut
   * that could pass without the real message-routing code ever running.
   */
  test('declining an incoming call logs it as missed', async ({ page }) => {
    await page.evaluate(() => {
      window.postMessage(
        {
          action: 'callStatus',
          data: { status: 'incoming', name: 'Test Caller', number: '5559876' }
        },
        '*'
      );
    });

    await expect(page.getByText('Decline')).toBeVisible();
    await page.getByText('Decline').click();

    // Same staleness as the outgoing case: nothing refetches Recents on its own here either.
    await page.locator('button[aria-label="Go back"]').click();
    await page.locator('button', { hasText: 'Phone' }).first().click();
    await page.getByRole('button', { name: 'Recents' }).click();
    // The declined-call toast's own text ("Test Caller (5559876)") also contains the
    // number, so this needs the exact match to land on the Recents row alone.
    const row = page.getByText('5559876', { exact: true });
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/text-error/);
  });
});
