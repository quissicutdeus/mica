import { test, expect, type Page } from '../support/test';
import { ALL_DEVICES, DEVICES, type DeviceId } from '@mica/shared/devices';
import { gotoDevice, settledFrameBox } from '../support/device';

/**
 * The notification shade and the control center (MICA-247, MICA-295) — one component
 * tree, mounted inside whichever frame is active (`Shell.svelte`'s `screen` snippet,
 * rendered the same way by `PhoneFrame` and `TabletFrame`), not redrawn per device.
 *
 * `control-center.spec.ts` and `notifications.spec.ts` own the phone's full gesture and
 * content coverage — every drag threshold, every swipe-to-clear case. This is the
 * parametrized proof that the two sheets open, close and toggle identically on the
 * tablet, at the tablet's own frame size, rather than a second copy of that whole file
 * with `phone-frame` swapped for `tablet-frame`.
 */

/** A window comfortably larger than the device's own frame, so nothing here is zoomed. */
const windowFor = (device: DeviceId) => ({
  width: DEVICES[device].frame.width + 400,
  height: DEVICES[device].frame.height + 400
});

/** Pull down from `fraction` of the way across the status bar, at the device's own scale. */
const pullStatusBar = async (page: Page, device: DeviceId, fraction: number) => {
  const box = await settledFrameBox(page, device);
  const scale = box.width / DEVICES[device].frame.width;
  const bar = await page.getByRole('button', { name: 'Open notification shade' }).boundingBox();
  if (!bar) throw new Error('status bar not on screen');
  const x = bar.x + bar.width * fraction;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Comfortably past the commit threshold, which is a fraction of the frame's own
  // height (`notifications.spec.ts`'s `SHADE_DRAG_REVEAL_DISTANCE`) — scaled so a
  // tablet's taller-in-px-but-shorter-in-ratio frame still clears it.
  await page.mouse.move(x, y + scale * DEVICES[device].frame.height * 0.85, { steps: 8 });
  await page.mouse.up();
};

for (const device of ALL_DEVICES) {
  test.describe(`Shade and control center on the ${device}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(windowFor(device));
      await gotoDevice(page, device);
      await settledFrameBox(page, device);
    });

    test('a pull from the left opens the shade, from the right opens the control center', async ({
      page
    }) => {
      await pullStatusBar(page, device, 0.3);
      await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Control Center' })).toHaveCount(0);

      // The home indicator relabels itself while the shade is open, on both frames.
      await page.getByRole('button', { name: 'Collapse notifications' }).click();
      await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toHaveCount(0);

      await pullStatusBar(page, device, 0.85);
      const cc = page.getByRole('dialog', { name: 'Control Center' });
      await expect(cc).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Close Control Center' }).click();
      await expect(cc).toHaveCount(0);
    });

    test('airplane mode toggles in the control center and locks the radios off', async ({
      page
    }) => {
      await pullStatusBar(page, device, 0.85);
      const cc = page.getByRole('dialog', { name: 'Control Center' });
      await expect(cc).toBeVisible();
      await expect
        .poll(async () => cc.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
        .toBe(0);

      const airplane = cc.getByTestId('cc-toggle-airplane');
      await expect(airplane).toHaveAttribute('aria-pressed', 'false');
      await airplane.click();
      await expect(airplane).toHaveAttribute('aria-pressed', 'true');
      await expect(cc.getByTestId('cc-toggle-bluetooth')).toBeDisabled();
      await airplane.click();
      await expect(airplane).toHaveAttribute('aria-pressed', 'false');
      await expect(cc.getByTestId('cc-toggle-bluetooth')).toBeEnabled();
    });
  });
}
