import { test, expect } from '@playwright/test';
import { openAppDrawer, dragIconTo, gridCellCenter } from './support/homeGrid';

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
