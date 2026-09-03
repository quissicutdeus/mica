import { test, expect } from './support/test';
import {
  openAppDrawer,
  dragIconTo,
  dragIconToRemoveTarget,
  gridCellCenter,
  seedHomeGrid
} from './support/homeGrid';

/**
 * The real drag-and-drop path onto the home grid — placing an app, and the two ways a
 * drop onto an occupied cell turns into a folder. Every other spec that just needs a
 * known app reachable from the home screen seeds `homeGridItems` directly
 * (`support/homeGrid.ts`'s `seedHomeGrid`) rather than driving this gesture; this file is
 * the one place the gesture itself is under test.
 */
test.describe('Home Grid drag-and-drop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('dragging an app from the drawer onto an empty cell places it on the home screen', async ({
    page
  }) => {
    await openAppDrawer(page);
    const icon = page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: 'Calculator' });
    const dest = await gridCellCenter(page, 0);
    await dragIconTo(page, icon, dest.x, dest.y);

    const placed = page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' });
    await expect(placed).toBeVisible();

    // It is really on the grid, not just visually dropped — `homeGridItems` is
    // server-synced storage, so it has to survive a reload.
    await page.reload();
    await expect(
      page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' })
    ).toBeVisible();
  });

  test('dropping an app onto another app creates an unnamed folder', async ({ page }) => {
    await openAppDrawer(page);
    let icon = page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: 'Calculator' });
    let dest = await gridCellCenter(page, 0);
    await dragIconTo(page, icon, dest.x, dest.y);
    await expect(
      page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' })
    ).toBeVisible();

    await openAppDrawer(page);
    icon = page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: 'Contacts' });
    dest = await gridCellCenter(page, 0);
    await dragIconTo(page, icon, dest.x, dest.y);

    // `folder.name` is '' until renamed — `Launcher.svelte` falls back to "Folder" as the
    // accessible name in that case.
    const folderButton = page
      .locator('[data-position="0"]')
      .getByRole('button', { name: 'Folder' });
    await expect(folderButton).toBeVisible();

    await folderButton.click();
    // Both apps left the grid for the folder — the popup carries the only surviving
    // "Calculator"/"Contacts" buttons, so no scoping is needed to tell them apart from
    // the grid's own icons.
    await expect(page.getByRole('button', { name: 'Calculator' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Contacts' })).toBeVisible();
  });

  /**
   * MICA-87. Pinning was one long-press and unpinning was nothing at all — the only
   * removals in `resolveIconDrop` were side effects of dropping the app somewhere else,
   * and a drop that hit nothing cancelled the drag rather than removing anything.
   */
  test.describe('removing an app from the home screen', () => {
    test.beforeEach(async ({ page }) => {
      // Seeded rather than dragged out of the drawer: the placement gesture has its own
      // tests above, and re-driving it here would make a removal failure indistinguishable
      // from a placement one. The reload is what `seedHomeGrid` needs — it is an
      // `addInitScript`, and the outer `beforeEach` has already navigated by the time this
      // one runs, so the write has to land before a *fresh* boot to be read at all.
      await seedHomeGrid(page, ['calculator']);
      await page.goto('/');
      await expect(
        page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' })
      ).toBeVisible();
    });

    test('the target is absent until an icon is actually picked up', async ({ page }) => {
      await expect(page.getByTestId('remove-drop-target')).toBeHidden();
    });

    test('dropping a pinned app on it takes the app off the grid for good', async ({ page }) => {
      const icon = page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' });
      await dragIconToRemoveTarget(page, icon);
      await expect(page.locator('[data-position="0"]').getByRole('button')).toHaveCount(0);

      // The grid is persisted storage, so a removal that only held in memory would come
      // back on the next boot. Asserted against the stored value rather than by reloading
      // the way the placement tests above do: `seedHomeGrid` is an `addInitScript`, which
      // re-runs on every navigation and would put the app straight back — a reload here
      // would test the seed, not the removal.
      await expect
        .poll(async () =>
          page.evaluate(() => window.localStorage.getItem('gos:settings:homeGridItems'))
        )
        .toBe('[]');
    });

    test('the app is still installed — it is back in the drawer, not uninstalled', async ({
      page
    }) => {
      const icon = page.locator('[data-position="0"]').getByRole('button', { name: 'Calculator' });
      await dragIconToRemoveTarget(page, icon);
      await expect(page.locator('[data-position="0"]').getByRole('button')).toHaveCount(0);

      await openAppDrawer(page);
      await expect(
        page.getByRole('dialog', { name: 'App Drawer' }).getByRole('button', { name: 'Calculator' })
      ).toBeVisible();
    });
  });

  test('naming a folder updates its icon label', async ({ page }) => {
    await openAppDrawer(page);
    let icon = page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: 'Calculator' });
    let dest = await gridCellCenter(page, 0);
    await dragIconTo(page, icon, dest.x, dest.y);

    await openAppDrawer(page);
    icon = page
      .getByRole('dialog', { name: 'App Drawer' })
      .getByRole('button', { name: 'Contacts' });
    dest = await gridCellCenter(page, 0);
    await dragIconTo(page, icon, dest.x, dest.y);

    const folderButton = page
      .locator('[data-position="0"]')
      .getByRole('button', { name: 'Folder' });
    await folderButton.click();

    const nameInput = page.getByPlaceholder('Unnamed');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Tools');
    // Blur, not Enter — the rename commits `onblur`, and there is no submit handler.
    await nameInput.press('Tab');
    await page.keyboard.press('Escape');

    await expect(
      page.locator('[data-position="0"]').getByRole('button', { name: 'Tools' })
    ).toBeVisible();

    // Persists like any other grid mutation.
    await page.reload();
    await expect(
      page.locator('[data-position="0"]').getByRole('button', { name: 'Tools' })
    ).toBeVisible();
  });
});
