import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * MICA-237: the Store lists what the *server* relays, and never fetches the catalog itself.
 *
 * A browser has no server, so the mock behind `store:catalog` plays it: it fetches the URL in
 * `?mica_addon_catalog=` (the per-page stand-in for the `mica_addon_catalog` convar, see
 * `nui/mocks/services/store.ts`) and answers `ok`, `unavailable` or `off` the way the server does.
 * `page.route` is the catalog's host here. Every spec below names the answer it wants, so it
 * does not depend on what the build was given in `VITE_MICA_ADDON_CATALOG`.
 *
 * What this cannot show is the server half or the real relay in game: those are
 * `server/__tests__`, and this drives the mock transport only.
 */

const CATALOG_URL = 'https://catalog.example/catalog.json';

const relayed = {
  id: 'relayed_weather',
  name: 'Relay Weather',
  version: '1.2.0',
  description: 'Weather that came through the server.',
  bundleUrl: 'https://catalog.example/apps/weather.js',
  sha256: 'a'.repeat(64),
  color: 'bg-blue-500',
  permissions: ['storage']
};

/** No `sha256`, no `bundleUrl`: `isCatalogEntry` refuses it and the row is dropped. */
const malformed = { id: 'relayed_broken', name: 'Relay Broken', version: '1.0.0' };

const openStore = async (page: Page, catalog: string) => {
  await seedHomeGrid(page, ['store']);
  await page.goto(`/?mica_addon_catalog=${encodeURIComponent(catalog)}`);
  await page.locator('button', { hasText: 'Store' }).first().click();
  await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
};

const row = (page: Page, name: string) =>
  page.locator('[data-testid="app-row"]', { hasText: name });

test.describe('Store catalog relayed by the server', () => {
  test('lists a relayed add-on beside the bundled ones, dropping a malformed row', async ({
    page
  }) => {
    await page.route(CATALOG_URL, (route) =>
      route.fulfill({ json: [relayed, malformed], headers: { 'access-control-allow-origin': '*' } })
    );
    await openStore(page, CATALOG_URL);

    await expect(row(page, 'Relay Weather')).toBeVisible();
    await expect(row(page, 'Relay Weather')).toContainText('Weather that came through the server.');
    // The bundled list is still there, and the row that failed validation is not.
    await expect(row(page, 'Notes')).toBeVisible();
    await expect(row(page, 'Relay Broken')).toHaveCount(0);
  });

  test('lists bundled add-ons only when the server cannot fetch the catalog', async ({ page }) => {
    await page.route(CATALOG_URL, (route) =>
      route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' } })
    );
    await openStore(page, CATALOG_URL);

    // `Notes` appears only once the listing has resolved, so the absence below is an answer
    // and not a fetch still in flight.
    await expect(row(page, 'Notes')).toBeVisible();
    await expect(row(page, 'Relay Weather')).toHaveCount(0);
  });

  test('lists bundled add-ons only when the operator has turned the catalog off', async ({
    page
  }) => {
    // A catalog that would list an add-on is on offer at the URL, and `off` must beat it.
    await page.route(CATALOG_URL, (route) =>
      route.fulfill({ json: [relayed], headers: { 'access-control-allow-origin': '*' } })
    );
    await openStore(page, 'off');

    await expect(row(page, 'Notes')).toBeVisible();
    await expect(row(page, 'Relay Weather')).toHaveCount(0);
  });
});
