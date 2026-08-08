import { test, expect } from '@playwright/test';

/**
 * Regressions for defects found in the pre-app-phase survey.
 *
 * Grouped in one file on purpose: each is a small, unrelated fix, and scattering them
 * into the app specs would bury what they are for.
 */

const openApp = async (page: import('@playwright/test').Page, name: string | RegExp) => {
  await page
    .getByRole('button', { name: typeof name === 'string' ? new RegExp(name, 'i') : name })
    .first()
    .click();

  /**
   * Wait for the app to actually be on screen.
   *
   * Components load on demand, so there is a moment between the tap and the code arriving
   * where the phone shows a spinner. A test that counted rows in that moment counted zero
   * — which is how this surfaced: `expect(0).toBeLessThan(0)`, from an assertion that had
   * been passing for the wrong reason.
   */
  await expect(page.locator('[data-testid="phone-screen"] h1').first()).toBeVisible();
};

const goHome = async (page: import('@playwright/test').Page) => {
  await page.locator("button[aria-label='Return to home screen']").click();
  await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('Backspace closes the open item before leaving the app', () => {
  // Both Notes and Contacts defined a goBack ladder and never claimed the key, so
  // Backspace jumped straight home from a detail view.
  //
  // Only Contacts is covered here: Notes is an add-on and is not on the home screen of a
  // fresh install. `src/sdk/backNavigation.test.ts` covers both statically, and covers
  // the whole class rather than two instances.
  test('Contacts', async ({ page }) => {
    await openApp(page, 'Contacts');
    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();

    await page.locator('[role="button"]').first().click();
    await page.keyboard.press('Backspace');

    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
    await expect(page.locator('h1', { hasText: 'gPhone' })).toHaveCount(0);
  });
});

test.describe('Store', () => {
  test('the tab switcher and filters show which one is active', async ({ page }) => {
    // The active styling was written as `class:` directives *inside* a class string, so
    // it rendered as literal text and nothing was ever highlighted.
    await openApp(page, 'Store');

    const catalog = page.getByRole('button', { name: 'Store Catalog' });
    const installed = page.getByRole('button', { name: /^Installed/ });

    await expect(catalog).toHaveAttribute('aria-pressed', 'true');
    await expect(installed).toHaveAttribute('aria-pressed', 'false');

    await installed.click();
    await expect(installed).toHaveAttribute('aria-pressed', 'true');
    await expect(catalog).toHaveAttribute('aria-pressed', 'false');

    // The All / System / Add-ons chips had the same defect.
    const all = page.getByRole('button', { name: 'All', exact: true });
    const system = page.getByRole('button', { name: 'System', exact: true });
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await system.click();
    await expect(system).toHaveAttribute('aria-pressed', 'true');
    await expect(all).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Photos', () => {
  test('a photo can be reported', async ({ page }) => {
    // ReportDialog was rendered but nothing ever opened it, so a photo could not be
    // reported at all.
    await openApp(page, 'Photos');
    await page.locator('img').first().click();

    await page.getByRole('button', { name: 'Report photo' }).click();
    await expect(page.getByText('Report content')).toBeVisible();
  });

  test('sharing says it is unimplemented instead of claiming success', async ({ page }) => {
    // Was a browser `alert('Photo shared! (Mock)')`.
    await openApp(page, 'Photos');
    await page.locator('img').first().click();

    await page.getByRole('button', { name: 'Share photo' }).click();
    await expect(page.getByText(/not implemented/i)).toBeVisible();
  });
});

test.describe('Lists can be used from the keyboard', () => {
  test('a mail opens on Enter, not only on click', async ({ page }) => {
    // `ListItem` is the row primitive behind Mail, Notes, Contacts, Messages and Store.
    // It announced itself as a button and could be tabbed to, and then ignored Enter —
    // the warning saying so was suppressed rather than answered, which left every list
    // in the phone reachable by keyboard and impossible to act on.
    await openApp(page, 'Mail');

    const row = page.locator('[role="button"]').first();
    await expect(row).toBeVisible();
    await row.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('h1', { hasText: 'Message' })).toBeVisible();
  });

  test('a photo opens on Enter', async ({ page }) => {
    // The grid was bare divs with no role and no tabindex, so the gallery could not be
    // opened from the keyboard at all.
    await openApp(page, 'Photos');

    const tile = page.getByRole('button', { name: /Open photo/ }).first();
    await tile.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Delete photo' })).toBeVisible();
  });
});

test.describe('Backgrounded apps are hidden without breaking focus', () => {
  test('leaving an app by Backspace logs no aria-hidden complaint', async ({ page }) => {
    // Resident apps are hidden with `inert`, and carried `aria-hidden` as well. The pair
    // is invalid the moment focus is inside: Back leaves focus on the app's own back
    // button, and the browser refuses to hide a subtree containing the focused element.
    // It printed on every trip home and nothing was watching the console.
    const complaints: string[] = [];
    page.on('console', (msg) => {
      if (/aria-hidden/i.test(msg.text())) complaints.push(msg.text());
    });

    await openApp(page, 'Mail');
    await page.locator("button[aria-label='Go back']").focus();
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    expect(complaints).toEqual([]);
  });

  test('a hidden app is inert and carries no aria-hidden', async ({ page }) => {
    await openApp(page, 'Mail');
    await goHome(page);

    const hidden = page.locator('div.absolute.inset-0.hidden').first();
    await expect(hidden).toHaveAttribute('inert', '');
    expect(await hidden.getAttribute('aria-hidden')).toBeNull();
  });
});

test.describe('Contacts', () => {
  test('sharing says it is unimplemented instead of claiming success', async ({ page }) => {
    // The same lie as Photos' old `alert(...)`, one layer deeper and so missed for
    // longer: the client callback logged to console and answered `{ success: true }`,
    // so the phone announced "Contact shared successfully" for a contact that never
    // left the machine. Nothing caught it — the callback was registered, which is all
    // the route table can check.
    await openApp(page, 'Contacts');
    await page.locator('[role="button"]').first().click();

    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText(/not implemented/i)).toBeVisible();
    await expect(page.getByText(/shared successfully/i)).toHaveCount(0);
  });
});

test.describe('Notes and Contacts persist in the browser mock', () => {
  // The mock handlers never touched their fixtures, so a created note vanished and a
  // deleted contact came back — while photos and mail behaved correctly.
  test('a deleted contact stays deleted across a re-entry', async ({ page }) => {
    await openApp(page, 'Contacts');
    const before = await page.locator('[role="button"]').count();

    await page.locator('[role="button"]').first().click();
    const del = page.getByRole('button', { name: /delete/i }).first();
    if ((await del.count()) === 0) test.skip();
    await del.click();

    // Contacts deletes straight away — there is no confirmation step to click through.
    // Wait for the detail view to close, which is what says the write came back. The
    // delete button is disabled while it is in flight, so clicking again would hang.
    await expect(del).toHaveCount(0);

    await goHome(page);
    await openApp(page, 'Contacts');
    expect(await page.locator('[role="button"]').count()).toBeLessThan(before);
  });
});
