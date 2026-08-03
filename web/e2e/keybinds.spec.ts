import { test, expect } from '@playwright/test';

test.describe('Keyboard Shortcuts E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('the Calculator deletes a digit before Backspace will leave it', async ({ page }) => {
    // Backspace is Back at shell level now, and the calculator needs it for deleting.
    // It claims the action while mounted and decides: delete first, leave once empty.
    // The old bug was the reverse — a raw listener that fired *alongside* the shell.
    await page.locator('button', { hasText: 'Calculator' }).first().click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    await page.locator('button', { hasText: '7' }).first().click();
    await page.locator('button', { hasText: '8' }).first().click();
    const display = page.locator('.text-6xl');
    await expect(display).toHaveText('78');

    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
    await expect(display).toHaveText('7');

    // Emptied, so the next press hands the action back to the shell.
    await page.keyboard.press('Backspace');
    await expect(display).toHaveText('0');
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('Escape puts the phone away rather than navigating', async ({ page }) => {
    await page.locator('button', { hasText: 'Calculator' }).first().click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    // Not "back to home" — straight out. The two were one action and could not be
    // told apart.
    //
    // Asserted on the collapsed-phone affordance rather than the phone's absence: in a
    // browser the frame's outro transition never completes and `<main>` stays in the
    // DOM. That is a pre-existing bug on the close path — the hardware power button
    // does it too — and not what this test is about.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Open gPhone/i })).toBeVisible();
  });

  test('the Open Phone key reopens a collapsed phone in the browser', async ({ page }) => {
    // `openPhone` is a FiveM key mapping, so in a browser nothing was listening and the
    // only way back was the mouse.
    //
    // Asserted on the collapsed-phone affordance rather than the phone's absence. It is a
    // plain `{#if !visible}` with no transition on it, so it flips the moment the state
    // does, where `<main>` waits out a 500ms fly and only then leaves the DOM.
    //
    // This test used to fail only in a full-suite run, which read as flakiness and was
    // not: `seedBrowserPhone` re-sent `setVisible: true` on a 1000ms timer, so a test that
    // closed the phone in that first second had it reopened underneath it. Fixed at the
    // source — the seed now lands immediately — so pressing Escape straight after `goto`
    // is safe.
    const openPhone = page.getByRole('button', { name: /Open gPhone/i });

    // And wait for the shell to be listening before pressing anything. The `keydown`
    // handler attaches in `onMount`, so a key sent between first paint and mount is
    // simply dropped — the phone never closes and the assertion below fails with no
    // indication that the press went nowhere. `appRegistryStore` is assigned at the end
    // of `installDevHarness`, which `onMount` calls, so it is a direct signal that the
    // listeners are up rather than a guess about timing.
    await page.waitForFunction(() => 'appRegistryStore' in window);

    await page.keyboard.press('Escape');
    await expect(openPhone).toBeVisible();

    await page.keyboard.press('m');
    await expect(openPhone).toBeHidden();
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('a bound key typed into the message composer is text, not a shortcut', async ({ page }) => {
    await page.locator('button', { hasText: 'Messages' }).first().click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();

    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();

    const composer = page.locator('textarea[placeholder="Message"]');
    await expect(composer).toBeVisible();
    await composer.click();

    // Rebind Back onto a plain letter first, so the press is unambiguously one the
    // dispatcher would otherwise claim.
    await page.evaluate(() => {
      localStorage.setItem('gphone:settings:keybinds', JSON.stringify({ back: 'q' }));
    });
    await page.reload();

    await page.locator('button', { hasText: 'Messages' }).first().click();
    await page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first().click();
    const composerAfter = page.locator('textarea[placeholder="Message"]');
    await composerAfter.click();
    await composerAfter.type('qq');

    // Both characters landed, and the shell did not navigate away.
    await expect(composerAfter).toHaveValue('qq');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toHaveCount(0);
  });

  test('a rebind set in Settings survives a UI reload', async ({ page }) => {
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Shortcuts' })).toBeVisible();

    // By id, not by text: a bare 'Back' also matches "End / Reject Call **Back**space",
    // which comes first in the list, and the test then rebound the wrong action.
    const backRow = page.getByTestId('shortcut-back');
    await expect(backRow).toBeVisible();
    await expect(backRow).toContainText('Backspace');

    await backRow.click();
    await expect(page.locator('text=Press a key…')).toBeVisible();
    await page.keyboard.press('q');
    await expect(backRow).toContainText('Q');

    await page.reload();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.getByTestId('shortcut-back')).toContainText('Q');

    // And the new key actually drives navigation, not just the label. Settings claims
    // `back` while mounted, so the first press steps up to the hub.
    await page.keyboard.press('q');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    await page.keyboard.press('q');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });
});
