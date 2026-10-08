import { expect, type Page } from '@playwright/test';
import { gotoDevice, pressDeviceKey, settledFrameBox } from './device';
import { seedHomeGrid } from './homeGrid';
import type { DeviceId } from '@mica/shared/devices';

/**
 * Install and uninstall through the Store of whichever device is on screen (MICA-264).
 *
 * A phone and a tablet keep installs of their own, so the old `installAddOn` (which only
 * knows the phone) is not a way to install on the tablet, and the Store has to be on that
 * device's own home grid to be reachable at all. These work on either frame; the row is
 * matched on the card and the button by exact role name, for the reasons `addon.ts` gives.
 */
const storeRow = (page: Page, name: string) =>
  page.locator('[data-testid="app-row"]', { hasText: name });

/** Seed both devices' grids so each can reach the Store, then boot as `device`. */
export const bootWithStore = async (
  page: Page,
  device: DeviceId,
  grids: { phone?: string[]; tablet?: string[] } = {}
): Promise<void> => {
  await seedHomeGrid(page, ['store', ...(grids.phone ?? [])], 'phone');
  await seedHomeGrid(page, ['store', ...(grids.tablet ?? [])], 'tablet');
  await gotoDevice(page, device);
  await settledFrameBox(page, device);
};

/** Open the Store from the home screen of the device on screen. */
export const openStore = async (page: Page): Promise<void> => {
  await page
    .getByRole('region', { name: 'Home Screen' })
    .getByRole('button', { name: /Store/ })
    .click();
  await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
};

export const goHome = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Return to home screen' }).click();
  await expect(page.getByRole('region', { name: 'Home Screen' })).toBeVisible();
};

/** Install `name` from the Store on the device on screen, and wait for it to land. */
export const installFromStore = async (page: Page, name: string): Promise<void> => {
  await openStore(page);
  await storeRow(page, name).getByRole('button', { name: 'Install', exact: true }).click();
  // The row flips to Uninstall once the registry has the app: the state, not a timer.
  await expect(storeRow(page, name).getByRole('button', { name: 'Uninstall' })).toBeVisible();
  await goHome(page);
};

/** Uninstall `name` through the Store on the device on screen, confirming the dialog. */
export const uninstallFromStore = async (page: Page, name: string): Promise<void> => {
  await openStore(page);
  await storeRow(page, name).getByRole('button', { name: 'Uninstall' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(
    storeRow(page, name).getByRole('button', { name: 'Install', exact: true })
  ).toBeVisible();
  await goHome(page);
};

/** Raise `device` with its key and wait for its frame, as the player does. */
export const switchTo = async (page: Page, device: DeviceId): Promise<void> => {
  await pressDeviceKey(page, device);
  await settledFrameBox(page, device);
};

export const homeButton = (page: Page, name: RegExp | string) =>
  page.getByRole('region', { name: 'Home Screen' }).getByRole('button', { name });
