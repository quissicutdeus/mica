import { test, expect } from './support/test';

/**
 * The home-screen search bar: the collapsed pill under the Dock, and the merged App
 * Drawer sheet it opens (focused) — search and the app grid are one sheet now.
 */

const openSearch = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeVisible();
};

const type = async (page: import('@playwright/test').Page, text: string) => {
  await page.getByLabel('Search your phone').fill(text);
};

test.describe('Home screen search', () => {
  test('the collapsed bar lines up with the outermost Dock icons', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    const bar = await page.getByRole('button', { name: 'Search', exact: true }).boundingBox();
    const icons = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button');
    const first = await icons.first().boundingBox();
    const last = await icons.last().boundingBox();
    if (!bar || !first || !last) throw new Error('search bar or dock icons not on screen');

    // The bar spans the icon row: its ends reach at least to the outermost icons, and it
    // never spills past the Dock's own `px-4` gutter into the screen edge.
    expect(bar.x).toBeLessThanOrEqual(first.x);
    expect(bar.x + bar.width).toBeGreaterThanOrEqual(last.x + last.width);

    // And it sits below the Dock rather than over it.
    expect(bar.y).toBeGreaterThan(first.y + first.height);
  });

  test('opening the sheet focuses the input without scrolling the phone frame (MICA-18)', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    // The input grabs focus while still off-screen, mid-`transition:fly` — without
    // `preventScroll`, the browser's default focus-follows-scroll yanked the phone
    // frame's own scroll position to "reveal" it, which read as the whole home screen
    // sliding down and back over the course of the open animation.
    const maxScrollTop = await page.evaluate(() => {
      const el = document.querySelector('.rounded-frame-inner');
      return new Promise<number>((resolve) => {
        let max = 0;
        let frames = 0;
        function tick() {
          if (el instanceof HTMLElement) max = Math.max(max, el.scrollTop);
          frames += 1;
          if (frames < 30) requestAnimationFrame(tick);
          else resolve(max);
        }
        requestAnimationFrame(tick);
        document.querySelector<HTMLButtonElement>('button[aria-label="Search"]')?.click();
      });
    });

    expect(maxScrollTop).toBe(0);
    await expect(page.getByLabel('Search your phone')).toBeFocused();
  });

  test('typing an app name finds the app and opens it', async ({ page }) => {
    await openSearch(page);
    await type(page, 'calcul');

    await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
    // Scoped to the sheet: an app that is also on the Dock or home grid would otherwise
    // match its icon there instead, and that icon is covered by the sheet.
    await page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: /Calculator/ })
      .click();

    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeHidden();
    await expect(page.locator('[data-testid="phone-screen"] h1').first()).toBeVisible();
  });

  test('an unmatched query says so instead of showing an empty sheet', async ({ page }) => {
    await openSearch(page);
    await type(page, 'zzzznope');

    await expect(page.getByText(/No results for/)).toBeVisible();
  });

  test('a contact is findable by name and opens its details', async ({ page }) => {
    await openSearch(page);
    // 'Trevor' is one of the browser mock's shipped contacts (`nui/mocks/data.ts`) and no
    // app is named anything like it, so this query reaches the Contacts group alone.
    await type(page, 'trevor');

    const sheet = page.getByRole('dialog', { name: 'App Drawer' });
    // The same name reaches both groups — the contact card and the conversation with them.
    await expect(sheet.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Messages' })).toBeVisible();

    // `.first()` is the contact: `searchEverything` fixes the group order, contacts ahead
    // of messages, so the first Trevor row is always the contact one.
    await sheet
      .getByRole('button', { name: /Trevor/ })
      .first()
      .click();

    // The deep link landed on the contact itself, not on the plain Contacts list.
    await expect(page.getByText('Contact Details')).toBeVisible();
  });

  test('the top handle closes the sheet without launching anything', async ({ page }) => {
    await openSearch(page);
    await type(page, 'camer');

    // The handle, not the scrim and not the keyboard. The scrim is only exposed in the
    // 40px band above the sheet's `top-10` edge, and the status bar's pull-down button
    // (`z-60`) covers that band entirely; the `back` keybind is not dispatched while focus
    // is in a text field, where Backspace means "delete a character".
    await page.getByTestId('drawer-top-handle').click();

    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeHidden();
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });
});
