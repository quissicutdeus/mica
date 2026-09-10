import { test, expect, type Page } from './support/test';
import { seedHomeGrid } from './support/homeGrid';
import { addOnFrame, installAddOn, openInstalledApp } from './support/addon';

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
 * Notes is the last describe, and it is the one that proves the whole path: it is
 * `core: false`, so its rows live in a sandboxed frame core may neither read nor name
 * (`sdk/coreBoundary.test.ts`). They reach this sheet only by the app answering the needle
 * through `useSearchProvider` (MICA-286), over the same `postMessage` seam everything else
 * an add-on does goes through — which is why it is worth an e2e rather than a unit test.
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

  test('a Snatchr listing, on that listing', async ({ page }) => {
    // The feed is not preloaded; the drawer fetched its first page when it opened, which
    // is what makes this row exist without Snatchr ever having been opened.
    await type(page, 'dirt bike');
    await (await expectOneHit(page, 'Listings', /Dirt Bike/)).click();

    await expect(page.locator('h1', { hasText: 'Snatchr' })).toBeVisible();
    // The listing's own screen, not the feed it sits in (MICA-286). The description and
    // the seller's contact buttons only exist on the detail read, so this is what
    // separates "opened the listing" from "opened the app with the listing on screen".
    await expect(page.getByText('Runs great, needs a new chain.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Call' })).toBeVisible();
  });
});

test.describe('An app contributes its own rows (MICA-286)', () => {
  test('a note, on that note', async ({ page }) => {
    // The real path a player takes to an add-on: the Store installs it, and opening it
    // once is what puts it in memory. An app that has never run this session has no code
    // to ask, which is the documented limit of `useSearchProvider` rather than a flake —
    // so this opens Notes first, on purpose.
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await installAddOn(page, 'Notes');
    await openInstalledApp(page, 'Notes');
    await expect(addOnFrame(page, 'notes').locator('h1', { hasText: 'Notes' })).toBeVisible();

    await page.locator("button[aria-label='Return to home screen']").click();
    await openSearch(page);

    // 'Grocery List' is a fixture of the Notes app alone; the shell holds no copy of it,
    // so a row under this heading is the frame having answered.
    await type(page, 'grocery');
    await (await expectOneHit(page, 'Notes', /Grocery List/)).click();

    // The hit carried `{ noteId }`, and the app's own `useDeepLink` opened it — the note's
    // title is the screen's, which the app root never shows.
    await expect(
      addOnFrame(page, 'notes').locator('h1', { hasText: 'Grocery List' })
    ).toBeVisible();
  });
});
