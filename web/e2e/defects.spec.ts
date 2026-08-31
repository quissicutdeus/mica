import { test, expect } from '@playwright/test';
import { seedHomeGrid } from './support/homeGrid';
import { settlePhoneOpen } from './support/phoneOpen';

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
  // The real home grid starts empty (MICA-5); every non-dock app this file opens by
  // name has to already be placed there.
  await seedHomeGrid(page, ['contacts', 'store', 'mail']);
  await page.goto('/');
});

test.describe('Backspace closes the open item before leaving the app', () => {
  // Both Notes and Contacts defined a goBack ladder and never claimed the key, so
  // Backspace jumped straight home from a detail view.
  //
  // Only Contacts is covered here: Notes is an add-on and is not on the home screen of a
  // fresh install. `sdk/backNavigation.test.ts` covers both statically, and covers
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

test.describe('Media', () => {
  test('a photo can be reported', async ({ page }) => {
    // ReportDialog was rendered but nothing ever opened it, so a photo could not be
    // reported at all.
    await openApp(page, 'Media');
    await page.locator('img').first().click();

    await page.getByRole('button', { name: 'Report photo' }).click();
    await expect(page.getByText('Report content')).toBeVisible();
  });

  test('sharing sends to nearby devices instead of claiming it is unimplemented', async ({
    page
  }) => {
    // Was a browser `alert('Photo shared! (Mock)')`, then a stub that said "not
    // implemented" forever. Bluetooth proximity drops are real now — this only guards
    // against the lie, either shape of it, coming back.
    await openApp(page, 'Media');
    await page.locator('img').first().click();

    await page.getByRole('button', { name: 'Send to nearby devices' }).click();
    await expect(page.getByText(/not implemented/i)).toHaveCount(0);
    await expect(page.getByText(/no bluetooth-visible players/i)).toBeVisible();
  });

  /**
   * The multi-select toolbar's own share button (MICA-57) — a second, independent
   * stub sitting right next to the one above, said "not implemented yet" long after the
   * single-photo path went real.
   */
  test('bulk sharing sends selected photos to nearby devices instead of claiming it is unimplemented', async ({
    page
  }) => {
    await openApp(page, 'Media');
    await page.getByRole('button', { name: 'Select' }).click();

    const photos = page.locator('img');
    await photos.first().click();
    await photos.nth(1).click();

    await page.locator('button[aria-label="Share selected"]').click();

    await expect(page.getByText(/not implemented/i)).toHaveCount(0);
    await expect(page.getByText(/no bluetooth-visible players/i)).toBeVisible();
  });

  test('a successful bulk share reports how many photos reached how many nearby devices', async ({
    page
  }) => {
    // `?bluetoothNearby=2` — the mock registry's own knob for a non-empty proximity
    // range, same param `shareMediaNearby`'s single-photo mock reads.
    await page.goto('/?bluetoothNearby=2');
    await openApp(page, 'Media');
    await page.getByRole('button', { name: 'Select' }).click();

    const photos = page.locator('img');
    await photos.first().click();
    await photos.nth(1).click();

    await page.locator('button[aria-label="Share selected"]').click();

    await expect(page.getByText('2 photos sent to 2 nearby phones.')).toBeVisible();
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
    await openApp(page, 'Media');

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
  test('sharing reaches a real server round trip instead of an unconditional claim', async ({
    page
  }) => {
    // The same lie as Media's old `alert(...)`, one layer deeper and so missed for
    // longer: the client callback logged to console and answered `{ success: true }`
    // unconditionally, so the phone announced "Contact shared successfully" for a
    // contact that never left the machine. Bluetooth proximity sharing is real now —
    // see `bluetooth-share.spec.ts` for both outcomes in full — this only guards
    // against either the old "not implemented" stub or an unconditional success
    // claim coming back.
    await openApp(page, 'Contacts');
    await page.locator('[role="button"]').first().click();

    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText(/not implemented/i)).toHaveCount(0);
    await expect(page.getByText(/shared successfully/i)).toHaveCount(0);
    await expect(page.getByText(/nobody nearby/i)).toBeVisible();
  });
});

test.describe('The first-run hint does not overlap the Dock', () => {
  // A fresh install ships with pinned Dock apps out of the box (`DEFAULT_DOCK_APP_IDS` in
  // `state/dock.ts`) and shows the "Swipe up for apps" hint until the drawer is opened
  // once. `Dock.svelte` positioned the hint at `bottom-32` and the Dock itself at
  // `bottom-10` with `py-4` padding, and the Dock's icon-and-label content was taller
  // than the gap between those two anchors — so the hint was drawn directly over the
  // pinned icons themselves on every fresh install, not just over blank padding above
  // them. Checked against an actual icon's box, not the Dock toolbar's own bounding box
  // (which includes its top padding) — overlapping that padding is harmless, since
  // nothing is drawn there and the hint is `pointer-events-none`.
  test('the hint sits above the Dock icons, not over them', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    // Both boxes below are read while the phone is on screen, and the phone flies in over
    // 500ms — without this the two reads sample the element at two different points in
    // that flight and the comparison is meaningless. See `support/phoneOpen.ts`.
    await settlePhoneOpen(page);

    const hint = page.getByText('Swipe up for apps');
    await expect(hint).toBeVisible();
    const hintBox = await hint.boundingBox();
    const iconBox = await page
      .getByRole('toolbar', { name: 'Dock' })
      .getByRole('button')
      .first()
      .boundingBox();
    if (!hintBox || !iconBox) throw new Error('hint or dock icon not on screen');

    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(iconBox.y);
  });
});

test.describe('Notes and Contacts persist in the browser mock', () => {
  // The mock handlers never touched their fixtures, so a created note vanished and a
  // deleted contact came back — while media and mail behaved correctly.
  test('a deleted contact stays deleted across a re-entry', async ({ page }) => {
    await openApp(page, 'Contacts');
    const before = await page.locator('[role="button"]').count();

    await page.locator('[role="button"]').first().click();
    // Exact, not a substring match: MICA-75-wiring added a "Recently Deleted" header
    // button, which a loose /delete/i regex also matches — after the real delete button
    // closes with the detail view, that locator would fall through to the header button
    // (always present, never reaching count 0) instead of proving the delete actually
    // completed. `ContactDetails.svelte`'s own button is `aria-label="Delete"`, exactly.
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
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
