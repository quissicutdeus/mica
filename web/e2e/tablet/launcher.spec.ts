import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, pressDeviceKey, settledFrameBox } from '../support/device';
import { installAddOn } from '../support/addon';

/**
 * An app appears on the tablet only if its manifest says so (MICA-260), and the three
 * reference apps do (MICA-261).
 *
 * The tablet's home grid is its own (`homeGridItems:tablet`), so the seed names the device.
 * Messages is seeded too, deliberately: a phone-only id on the tablet's grid renders an
 * empty cell, never an icon, which is the visibility rule at the surface a player sees.
 */
test('Admin and Settings are on the tablet launcher and Messages is not', async ({ page }) => {
  await seedHomeGrid(page, ['admin', 'settings', 'messages'], 'tablet');
  await gotoDevice(page, 'tablet');
  await settledFrameBox(page, 'tablet');

  const home = page.getByRole('region', { name: 'Home Screen' });
  await expect(home.getByRole('button', { name: /Admin/i })).toBeVisible();
  await expect(home.getByRole('button', { name: /Settings/i })).toBeVisible();
  await expect(home.getByRole('button', { name: /Messages/i })).toHaveCount(0);
});

test('Notes, installed on the phone, is on the tablet too', async ({ page }) => {
  // The Store is a phone app, so the install happens there; the installed set is the
  // player's, not the device's, and the tablet's grid names Notes.
  await seedHomeGrid(page, ['store']);
  await seedHomeGrid(page, ['notes'], 'tablet');
  await gotoDevice(page, 'phone');
  await installAddOn(page, 'Notes');

  await pressDeviceKey(page, 'tablet');
  await settledFrameBox(page, 'tablet');
  await expect(
    page.getByRole('region', { name: 'Home Screen' }).getByRole('button', { name: /Notes/ })
  ).toBeVisible();
});

test('switching device keeps each device on the screen it was left on', async ({ page }) => {
  await seedHomeGrid(page, ['settings']);
  await seedHomeGrid(page, ['admin'], 'tablet');
  await gotoDevice(page, 'phone');
  await settledFrameBox(page, 'phone');

  // Open Settings on the phone, then raise the tablet: it comes up on its own home.
  await page
    .getByRole('button', { name: /Settings/i })
    .first()
    .click();
  await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  await pressDeviceKey(page, 'tablet');
  await settledFrameBox(page, 'tablet');
  await expect(page.getByRole('region', { name: 'Home Screen' })).toBeVisible();

  // Open Admin on the tablet, go back to the phone: Settings is still up there.
  await page.getByRole('button', { name: /Admin/i }).first().click();
  await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
  await pressDeviceKey(page, 'phone');
  await settledFrameBox(page, 'phone');
  await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

  // And the tablet is still on Admin.
  await pressDeviceKey(page, 'tablet');
  await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
});
