import { test, expect, type Page } from './support/test';

/**
 * MICA-248: the home search reaches every source the shell can see, one section each,
 * and a tap on a result lands *on the item*, not merely in the app.
 *
 * Every query below is chosen to hit exactly one fixture in exactly one source — the
 * seeded rows are in `web/src/nui/mocks/data.ts` — so a section heading appearing is
 * evidence of that source and no other. The assertion after the tap is "the right
 * screen is showing": a result that resolves and renders the app root is the failure
 * being pinned, the same rule `deep-links.spec.ts` follows.
 *
 * Notes is not here, deliberately. It is `core: false`, and core may not name an add-on
 * (`sdk/coreBoundary.test.ts`), so its rows reach the home search only through the
 * app-contributed `SearchProvider` slot in `shell/state/searchResults.ts`, which needs an
 * SDK hook to declare into. Add its case when that hook exists.
 */

const sheet = (page: Page) => page.getByRole('dialog', { name: 'App Drawer' });

const openSearch = async (page: Page) => {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(sheet(page)).toBeVisible();
};

const type = async (page: Page, text: string) => {
  await page.getByLabel('Search your phone').fill(text);
};

/** The one section heading the query should produce, and the one row under it. */
const expectOneHit = async (page: Page, section: string, row: RegExp) => {
  await expect(sheet(page).getByRole('heading', { name: section, exact: true })).toBeVisible();
  const hits = sheet(page).getByRole('button', { name: row });
  await expect(hits).toHaveCount(1);
  return hits.first();
};

test.describe('Home search reaches every source (MICA-248)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    await openSearch(page);
  });

  test('an app', async ({ page }) => {
    await type(page, 'calcul');
    await (await expectOneHit(page, 'Apps', /Calculator/)).click();

    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('[data-testid="phone-screen"] h1').first()).toBeVisible();
  });

  test('a contact, on its details', async ({ page }) => {
    // Brucie reaches the Contacts group alone: he has no conversation fixture.
    await type(page, 'brucie');
    await (await expectOneHit(page, 'Contacts', /Brucie/)).click();

    await expect(page.getByText('Contact Details')).toBeVisible();
  });

  test('a conversation, on its thread', async ({ page }) => {
    // Trevor is both a contact and a thread; the Messages row is the one under its heading.
    await type(page, 'trevor');
    await expect(sheet(page).getByRole('heading', { name: 'Messages' })).toBeVisible();
    await sheet(page)
      .getByRole('button', { name: /Trevor/ })
      .nth(1)
      .click();

    await expect(page.locator('button', { hasText: 'Trevor Philips' }).first()).toBeVisible();
  });

  test('a gallery item, on that item', async ({ page }) => {
    // Fixture 900, a video captioned 'Dashcam clip'; inside the first page the preload holds.
    await type(page, 'dashcam');
    await (await expectOneHit(page, 'Media', /Dashcam clip/)).click();

    // The Media app's detail level titles itself 'Photo' whatever the kind.
    await expect(page.locator('h1', { hasText: 'Photo' })).toBeVisible();
  });

  test('a mail message, opened', async ({ page }) => {
    await type(page, 'citation');
    await (await expectOneHit(page, 'Mail', /Traffic Citation Notice/)).click();

    await expect(page.locator('h1', { hasText: 'Message' })).toBeVisible();
    await expect(page.getByText('Citation #90214')).toBeVisible();
  });

  test('a Snatchr listing, on the feed', async ({ page }) => {
    // The feed is not preloaded; the drawer fetched its first page when it opened, which
    // is what makes this row exist without Snatchr ever having been opened.
    await type(page, 'dirt bike');
    await (await expectOneHit(page, 'Listings', /Dirt Bike/)).click();

    // No per-listing deep link yet — the app root is the contract, and the listing is on it.
    await expect(page.locator('h1', { hasText: 'Snatchr' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Dirt Bike' })).toBeVisible();
  });
});
