import { test, expect, type Page } from './support/test';
import { seedHomeGrid, openAppDrawer } from './support/homeGrid';
import { addOnFrame } from './support/addon';

/**
 * MICA-234: an owner disables apps, seeds default contacts and sets the dock through
 * `server.cfg` convars, with no TypeScript edit and no rebuild.
 *
 * `shared/ownerConfig.ts` parses `mica_disabled_apps`, `mica_default_dock` and
 * `mica_default_contacts` once; this suite is against the mock transport's read of the
 * same three query params (`web/src/nui/mocks/registry.ts`'s own convention — see
 * `defects.spec.ts`'s `?bluetoothNearby=2`), not against the parser itself. The parser has
 * its own unit tests; this is the wiring from a URL to what a player actually sees, across
 * every surface an app can appear on. As of this file's own commit the wiring does not
 * exist yet — `shell:ownerConfig` has a contract and a store and nothing reads either from
 * the launcher, the dock or the Store — so every test below is expected red until the web
 * and server lanes land.
 *
 * `hodlr` and `snek` stand in for "some disableable app": both are `core: false`, so they
 * are exactly what an owner running a light install would disable, and neither collides
 * with an id any other spec in this suite depends on being present. `settings` never is —
 * disabling it is the one input the parser refuses outright.
 */

/** A grid position an app was pinned to (or a folder) before the owner disabled anything. */
const seedGridItems = async (page: Page, items: unknown[]): Promise<void> => {
  await page.addInitScript((items) => {
    // Top window only — a sandboxed add-on frame has no `localStorage` access at all
    // (see `support/homeGrid.ts`'s `seedHomeGrid`, which this mirrors).
    if (window !== window.top) return;
    window.localStorage.setItem('mica:settings:homeGridItems', JSON.stringify(items));
  }, items);
};

/** Marks an id as already installed, the same storage `registry.ts`'s Store writes to. */
const seedInstalledAddOns = async (page: Page, ids: string[]): Promise<void> => {
  await page.addInitScript((ids) => {
    if (window !== window.top) return;
    window.localStorage.setItem('mica:store:installedAddOns', JSON.stringify(ids));
  }, ids);
};

const gotoHome = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`/${query}`);
  await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
};

test.describe('An owner-disabled app', () => {
  test('disappears from the home grid it was already pinned to, leaving other apps in place', async ({
    page
  }) => {
    await seedInstalledAddOns(page, ['hodlr']);
    await seedGridItems(page, [
      { position: 0, kind: 'app', appId: 'hodlr' },
      { position: 1, kind: 'app', appId: 'calculator' }
    ]);

    await gotoHome(page, '?mica_disabled_apps=hodlr');

    await expect(page.getByRole('button', { name: /Hodlr/ })).toHaveCount(0);
    await expect(
      page.locator('[data-position="1"]').getByRole('button', { name: 'Calculator' })
    ).toBeVisible();
  });

  test('disappears from a folder popup it was already inside, leaving its folder-mate visible', async ({
    page
  }) => {
    await seedInstalledAddOns(page, ['hodlr']);
    await seedGridItems(page, [
      { position: 0, kind: 'folder', folderId: 'f1', name: '', appIds: ['hodlr', 'calculator'] }
    ]);

    await gotoHome(page, '?mica_disabled_apps=hodlr');
    await page.locator('[data-position="0"]').getByRole('button', { name: 'Folder' }).click();

    await expect(page.getByRole('button', { name: /Hodlr/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Calculator' })).toBeVisible();
  });

  test('is absent from the App Drawer, other apps still listed', async ({ page }) => {
    await seedInstalledAddOns(page, ['hodlr']);

    await gotoHome(page, '?mica_disabled_apps=hodlr');
    await openAppDrawer(page);

    const drawer = page.getByRole('dialog', { name: 'App Drawer' });
    await expect(drawer.getByRole('button', { name: /Hodlr/ })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Calculator' })).toBeVisible();
  });

  test('is unreachable from home search, other apps still findable', async ({ page }) => {
    await seedInstalledAddOns(page, ['hodlr']);

    await gotoHome(page, '?mica_disabled_apps=hodlr');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'App Drawer' });
    await expect(drawer).toBeVisible();

    const search = page.getByLabel('Search your phone');
    await search.fill('hodlr');
    await expect(page.getByText(/No results for/)).toBeVisible();

    await search.fill('calcul');
    await expect(drawer.getByRole('button', { name: /Calculator/ })).toBeVisible();
  });

  test('leaves its dock slot an empty placeholder rather than an icon', async ({ page }) => {
    await seedInstalledAddOns(page, ['hodlr']);
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.localStorage.setItem(
        'mica:settings:dockAppIds',
        JSON.stringify(['hodlr', '', '', ''])
      );
    });

    await gotoHome(page, '?mica_disabled_apps=hodlr');

    const slot0 = page.getByRole('toolbar', { name: 'Dock' }).locator('[data-dock-index="0"]');
    await expect(slot0.getByRole('button')).toHaveCount(0);
  });

  test('and its Store-mate are both absent from the Store catalog, a third add-on stays listed', async ({
    page
  }) => {
    await seedHomeGrid(page, ['store']);

    await gotoHome(page, '?mica_disabled_apps=hodlr,snek');
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();

    const catalogCard = (name: string) =>
      page.locator('[data-testid="app-row"]', { hasText: name });
    await expect(catalogCard('Hodlr')).toHaveCount(0);
    await expect(catalogCard('Snek')).toHaveCount(0);
    await expect(catalogCard('Notes')).toBeVisible();
  });

  test('does nothing when opened by deep link, and the same link opens it when it is not disabled', async ({
    page
  }) => {
    await gotoHome(page, '?app=hodlr&mica_disabled_apps=hodlr');
    // Still home — no add-on frame was ever created for it.
    await expect(page.locator('iframe[data-app="hodlr"]')).toHaveCount(0);

    // The control: the identical link, absent the convar, is `deep-link.spec.ts`'s own
    // "opens an app that is not installed by default" case — proof this test can fail.
    await page.goto('/?app=hodlr');
    await expect(addOnFrame(page, 'hodlr').locator('h1', { hasText: 'Hodlr' })).toBeVisible();
  });
});

test('settings cannot be disabled by the owner convar', async ({ page }) => {
  await page.goto('/?app=settings&mica_disabled_apps=settings');
  await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
});

test.describe('An owner-configured dock', () => {
  test('replaces the built-in default when no player has arranged one yet', async ({ page }) => {
    await gotoHome(page, '?mica_default_dock=phone,,camera,messages');

    const dock = page.getByRole('toolbar', { name: 'Dock' });
    await expect(
      dock.locator('[data-dock-index="0"]').getByRole('button', { name: /Phone/ })
    ).toBeVisible();
    await expect(dock.locator('[data-dock-index="1"]').getByRole('button')).toHaveCount(0);
    await expect(
      dock.locator('[data-dock-index="2"]').getByRole('button', { name: /Camera/ })
    ).toBeVisible();
    await expect(
      dock.locator('[data-dock-index="3"]').getByRole('button', { name: /Messages/ })
    ).toBeVisible();
  });

  test('is ignored once a player has arranged their own dock', async ({ page }) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.localStorage.setItem(
        'mica:settings:dockAppIds',
        JSON.stringify(['calculator', '', '', ''])
      );
    });

    await gotoHome(page, '?mica_default_dock=phone,,camera,messages');

    const dock = page.getByRole('toolbar', { name: 'Dock' });
    await expect(
      dock.locator('[data-dock-index="0"]').getByRole('button', { name: 'Calculator' })
    ).toBeVisible();
    // The convar's slot 2 (camera) did not get written over the player's own empty slot.
    await expect(dock.locator('[data-dock-index="2"]').getByRole('button')).toHaveCount(0);
  });
});

test('a configured default contact appears in Contacts, alongside the shipped ones', async ({
  page
}) => {
  const contacts = JSON.stringify([{ name: 'Quartermaster', number: '555-0142' }]);
  await seedHomeGrid(page, ['contacts']);

  await gotoHome(page, `?mica_default_contacts=${encodeURIComponent(contacts)}`);
  await page.locator('button', { hasText: 'Contacts' }).first().click();
  await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();

  await expect(page.getByRole('button', { name: /Quartermaster/ })).toBeVisible();
  // 'Trevor' is one of the browser mock's shipped contacts (`nui/mocks/data.ts`,
  // `home-search.spec.ts` also reaches for it) — proof the default is additive, not a
  // replacement for the phone's own seed data.
  await expect(page.getByRole('button', { name: /Trevor/ })).toBeVisible();
});

test('with no owner convars set, the phone is unchanged from its existing baseline', async ({
  page
}) => {
  await gotoHome(page);

  const dock = page.getByRole('toolbar', { name: 'Dock' });
  await expect(
    dock.locator('[data-dock-index="0"]').getByRole('button', { name: /Phone/ })
  ).toBeVisible();
});
