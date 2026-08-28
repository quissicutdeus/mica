import { test, expect } from '@playwright/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * Snatchr, end to end against the browser mock (MICA-59).
 *
 * `core: true`, so unlike Hodlr and Snek there is no Store install to walk: the app ships
 * with the phone and runs in-process, which is also why every locator here is page-level
 * rather than reaching into an add-on's iframe. It is absent from the dock, though, so the
 * home grid is seeded with it (MICA-5 left the real grid empty).
 *
 * Its four screens each have a component test already. What none of them can reach is the
 * navigation between them and the store both sides share — a listing posted on the create
 * screen appearing in the feed and in My Listings, and a status written from My Listings
 * being reflected back in the row. That is what this drives.
 *
 * Fixtures: `mockListings` in `web/src/nui/mocks/data.ts` — Dirt Bike (4500) and Burner
 * Phone (150), both active.
 */
test.describe('Snatchr', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['marketplace']);
    await page.goto('/');
    // The manifest id is `marketplace`; the display name is Snatchr, and the launcher
    // label is what a player clicks.
    await page.getByRole('button', { name: /Snatchr/ }).click();
    await expect(page.locator('h1', { hasText: 'Snatchr' })).toBeVisible();
  });

  const listingCard = (page: import('@playwright/test').Page, title: string) =>
    page.locator('button', { hasText: title });

  test('browses the feed, narrows it by search, and opens a listing', async ({ page }) => {
    await expect(listingCard(page, 'Dirt Bike')).toBeVisible();
    await expect(listingCard(page, 'Burner Phone')).toBeVisible();

    /**
     * The search is debounced by 300ms and answered by `marketplace:search`, which filters
     * on title *and* description — so a query that only matches a description is what
     * proves the request reached the mock rather than the input filtering rows locally.
     * "no questions" appears in Burner Phone's description and nowhere in its title.
     *
     * No sleep for the debounce: the assertions below retry until the results land, which
     * is the same condition without the race (MICA-34).
     */
    await page.getByPlaceholder('Search listings').fill('no questions');
    await expect(listingCard(page, 'Dirt Bike')).toHaveCount(0);
    await expect(listingCard(page, 'Burner Phone')).toBeVisible();

    await listingCard(page, 'Burner Phone').click();

    // The detail screen is a second read (`marketplace:view`), not a projection of the feed
    // row: the description and the seller's phone only exist on this response.
    await expect(page.getByText('Clean, no questions.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Call' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Text' })).toBeVisible();
  });

  test('posts a listing, caps its photos at four, and sells it off My Listings', async ({
    page
  }) => {
    await page.getByRole('button', { name: 'Create listing' }).click();

    await page.getByPlaceholder('Title').fill('Sandy Shores Trailer');
    await page.getByPlaceholder('Price').fill('7500');
    await page.getByPlaceholder('Description').fill('Off grid, no neighbours.');

    /**
     * The four-photo cap, end to end. `CreateListing.test.ts` asserts the guard on the
     * component; this drives the picker a player actually taps, and the counter on the
     * button is the only thing that tells them the fifth tap did nothing. The gallery mock
     * holds 24 items, so there is a fifth to tap.
     */
    await page.getByRole('button', { name: /Add photos/ }).click();
    const picker = page.locator('div.z-30', { has: page.getByRole('button', { name: 'Done' }) });
    const photos = picker.locator('button.aspect-square');
    for (let i = 0; i < 5; i += 1) await photos.nth(i).click();
    await expect(page.getByRole('button', { name: 'Add photos (4/4)' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Post' }).click();

    // Posting lands on the new listing's own detail screen, which is a fresh `view` read of
    // the id the create returned — so this is the row as the server now holds it, not the
    // form's own state echoed back.
    await expect(page.getByText('Sandy Shores Trailer')).toBeVisible();
    await expect(page.getByText('Off grid, no neighbours.')).toBeVisible();

    // Exact: the app's own in-screen back arrow, not the `Screen` header's "Go back",
    // which a substring match also hits.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(listingCard(page, 'Sandy Shores Trailer')).toBeVisible();

    await page.getByRole('button', { name: 'My Listings' }).click();
    const mine = page.locator('li', { hasText: 'Sandy Shores Trailer' });
    await expect(mine).toContainText('7500 · active');

    await mine.getByRole('button', { name: 'Mark Sold' }).click();

    // The status the row reports, and the disappearance of the actions with it — a sold
    // listing has nothing left to do to it, and both halves come from the same write.
    await expect(mine).toContainText('7500 · sold');
    await expect(mine.getByRole('button', { name: 'Mark Sold' })).toHaveCount(0);
    await expect(mine.getByRole('button', { name: 'Remove' })).toHaveCount(0);

    // Remove is the other terminal status, and it is a different action on the service.
    const dirtBike = page.locator('li', { hasText: 'Dirt Bike' });
    await dirtBike.getByRole('button', { name: 'Remove' }).click();
    await expect(dirtBike).toContainText('4500 · removed');
  });
});
