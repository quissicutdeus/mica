import { test, expect } from '../support/test';
import { DEVICES } from '@gos/shared/devices';
import { gotoDevice, pressDeviceKey, settledFrameBox } from '../support/device';

/**
 * The shell renders a device, and the tablet is the second one (MICA-259, MICA-261).
 *
 * These run under the `tablet` Playwright project, on a 1440x1000 window: room for the
 * frame and its margins, which the suite's default 1280x960 does not have. The specs that
 * need a specific window say so themselves.
 */

const DESIGN = DEVICES.tablet.frame;

test('?device=tablet boots a 1280 x 800 landscape frame with the tablet chrome', async ({
  page
}) => {
  // Room for the whole range: the fit has to exceed MAX_SCALE for the default setting to
  // land on design size, exactly as `display.spec.ts` arranges for the phone.
  await page.setViewportSize({ width: 1920, height: 1300 });
  await gotoDevice(page, 'tablet');

  const box = await settledFrameBox(page, 'tablet');
  expect(box.width).toBeCloseTo(DESIGN.width, 0);
  expect(box.height).toBeCloseTo(DESIGN.height, 0);

  // One frame at a time, and this one has none of the phone's body.
  await expect(page.getByTestId('phone-frame')).toHaveCount(0);
  await expect(page.getByTestId('camera-cutout')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open notification shade' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to home screen' })).toBeVisible();

  // The launcher is the tablet's: a six-slot dock under a home screen.
  await expect(page.getByRole('region', { name: 'Home Screen' })).toBeVisible();
  await expect(page.getByRole('toolbar').locator('[data-dock-index]')).toHaveCount(
    DEVICES.tablet.launcher.dockSlots
  );
});

test('the tablet keeps its ratio on a window it does not fit', async ({ page }) => {
  // The suite's default window: the phone fits here with room to spare, the tablet needs
  // 1312px of width and yields zoom rather than shape.
  await page.setViewportSize({ width: 1280, height: 960 });
  await gotoDevice(page, 'tablet');

  const box = await settledFrameBox(page, 'tablet');
  expect(box.width).toBeLessThan(DESIGN.width);
  expect(box.width / box.height).toBeCloseTo(DESIGN.width / DESIGN.height, 2);
});

test('each device answers to its own key in a browser', async ({ page }) => {
  await gotoDevice(page, 'tablet');
  await settledFrameBox(page, 'tablet');

  // The key of the device on screen puts it down.
  await pressDeviceKey(page, 'tablet');
  await expect(page.getByTestId('tablet-frame')).toHaveCount(0);

  // The phone's key raises the phone, not the tablet the page booted with.
  await pressDeviceKey(page, 'phone');
  await expect(page.getByTestId('phone-frame')).toBeVisible();
  await expect(page.getByTestId('tablet-frame')).toHaveCount(0);

  // And the tablet's key, with the phone up, swaps to the tablet.
  await pressDeviceKey(page, 'tablet');
  await expect(page.getByTestId('tablet-frame')).toBeVisible();
  await expect(page.getByTestId('phone-frame')).toHaveCount(0);
});
