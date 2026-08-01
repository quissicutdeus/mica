import { test, expect } from '@playwright/test';

/**
 * Apps stay mounted once opened, so leaving one and coming back finds it as you left it.
 *
 * Previously the shell mounted a single app under `{#key currentApp.name}`, so every
 * navigation destroyed the component. That is structural rather than a bug in any one
 * app, and it forced real workarounds — the DevTools unlock had to be written to
 * storage purely to survive a trip to another app.
 *
 * Scroll offset is the case worth testing hardest: it lives in the DOM rather than in
 * any component variable, so no save/restore API would have captured it, and it is lost
 * if a hidden app stops being laid out.
 */

/**
 * Role-based, so hidden resident apps are excluded: they carry `inert` and
 * `aria-hidden`, which keeps them out of the accessibility tree even though their DOM
 * is still present and laid out.
 *
 * Unanchored, because an unread badge prefixes the accessible name — Mail's is
 * "1 Mail", not "Mail".
 */
const openApp = async (page: import('@playwright/test').Page, name: string) => {
  await page
    .getByRole('button', { name: new RegExp(name, 'i') })
    .first()
    .click();
  await expect(page.locator('h1', { hasText: name })).toBeVisible();
};

/** The home-indicator bar at the bottom of the frame; always present, app-independent. */
const goHome = async (page: import('@playwright/test').Page) => {
  await page.locator("button[aria-label='Return to home screen']").click();
  await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
};

test.describe('App residency', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('in-app state survives a trip to another app', async ({ page }) => {
    await openApp(page, 'Calculator');
    await page.getByRole('button', { name: '7', exact: true }).click();
    const display = page.locator('.text-6xl');
    await expect(display).toHaveText('7');

    await goHome(page);
    await openApp(page, 'Contacts');
    await goHome(page);
    await openApp(page, 'Calculator');

    // The old shell re-keyed on app name, so this came back as '0'.
    await expect(page.locator('.text-6xl')).toHaveText('7');
  });

  test('a hidden app is not reachable by keyboard or assistive tech', async ({ page }) => {
    // Residency means the DOM of an inactive app is still present. It must not be
    // focusable or announced, or the phone would have invisible tab stops.
    await openApp(page, 'Calculator');
    await goHome(page);

    const hidden = page.locator('[inert]');
    await expect(hidden).toHaveCount(1);
    await expect(hidden).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('button', { name: '7', exact: true })).toHaveCount(0);
  });

  test('scroll position survives an app switch', async ({ page }) => {
    // Contacts, because its list is long enough to actually scroll — Settings' hub is
    // shorter than the screen and scrollTop stays 0, which would pass vacuously.
    await openApp(page, 'Contacts');
    const scroller = page.locator('.overflow-y-auto').first();
    await scroller.evaluate((el) => el.scrollTo(0, 120));
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    await goHome(page);
    await openApp(page, 'Contacts');

    const after = await page
      .locator('.overflow-y-auto')
      .first()
      .evaluate((el) => el.scrollTop);
    expect(after).toBe(before);
  });

  test('only the active app is visible', async ({ page }) => {
    await openApp(page, 'Calculator');
    await goHome(page);
    await openApp(page, 'Contacts');

    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeHidden();
  });

  test('evicts the least recently used app past the residency cap', async ({ page }) => {
    // MAX_RESIDENT_APPS is 5. Unbounded residency would keep every app ever opened
    // alive for the session, timers and subscriptions included.
    const apps = ['Calculator', 'Mail', 'Contacts', 'Settings', 'Store', 'Bank'];
    for (const name of apps) {
      await goHome(page);
      await openApp(page, name);
    }
    await goHome(page);

    // Six opened, five resident: the first is gone.
    await expect(page.locator('[inert]')).toHaveCount(5);
  });
});
