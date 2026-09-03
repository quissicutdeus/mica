import { test, expect, type Page } from '../support/test';
import { DEVICES } from '@gphone/shared/devices';

/**
 * The shell renders a device, and the tablet is the second one (MICA-259).
 *
 * `?device=tablet` is the browser's way in — the query the demo container boots by. In
 * game the client's `setVisible` names the device and the URL carries nothing. These
 * specs are the first under `e2e/tablet/`; the tablet-specific Admin, Settings and Notes
 * roots arrive with MICA-261 and their specs beside this one.
 */

const DESIGN = DEVICES.tablet.frame;

/** The frame's rendered rectangle, after the fly-in has landed — `display.spec.ts`'s wait. */
const tabletBox = async (page: Page) => {
  const frame = page.getByTestId('tablet-frame');
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  const box = await frame.boundingBox();
  if (!box) throw new Error('the tablet frame is not on screen');
  return box;
};

test('?device=tablet boots a 1280 x 800 landscape frame with the tablet chrome', async ({
  page
}) => {
  // Room for the whole range: the fit has to exceed MAX_SCALE for the default setting to
  // land on design size, exactly as `display.spec.ts` arranges for the phone.
  await page.setViewportSize({ width: 1920, height: 1300 });
  await page.goto('/?device=tablet');

  const box = await tabletBox(page);
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
  await page.goto('/?device=tablet');

  const box = await tabletBox(page);
  expect(box.width).toBeLessThan(DESIGN.width);
  expect(box.width / box.height).toBeCloseTo(DESIGN.width / DESIGN.height, 2);
});

test('each device answers to its own key in a browser', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1300 });
  await page.goto('/?device=tablet');
  await tabletBox(page);

  // The key of the device on screen puts it down.
  await page.keyboard.press(DEVICES.tablet.keybind.defaultKey);
  await expect(page.getByTestId('tablet-frame')).toHaveCount(0);

  // The phone's key raises the phone, not the tablet the page booted with.
  await page.keyboard.press(DEVICES.phone.keybind.defaultKey);
  await expect(page.getByTestId('phone-frame')).toBeVisible();
  await expect(page.getByTestId('tablet-frame')).toHaveCount(0);

  // And the tablet's key, with the phone up, swaps to the tablet.
  await page.keyboard.press(DEVICES.tablet.keybind.defaultKey);
  await expect(page.getByTestId('tablet-frame')).toBeVisible();
  await expect(page.getByTestId('phone-frame')).toHaveCount(0);
});
