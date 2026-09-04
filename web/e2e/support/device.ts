import { expect, type Page } from '@playwright/test';
import { DEVICES, type DeviceId } from '@mica/shared/devices';

/**
 * Boot the page as a device (MICA-261).
 *
 * `?device=tablet` is the browser's way in: `Shell.svelte` reads it in its browser-only
 * boot and raises that frame instead of the phone. In game the client's `setVisible`
 * names the device and the URL carries nothing, so this helper is the e2e stand-in for
 * the client, exactly as `seedBrowserPhone` is for the dev browser.
 */
export const gotoDevice = async (page: Page, device: DeviceId, path = '/'): Promise<void> => {
  const url =
    device === 'phone' ? path : `${path}${path.includes('?') ? '&' : '?'}device=${device}`;
  await page.goto(url);
};

/** The frame's test id: `phone-frame` or `tablet-frame`, as the two components name them. */
export const frameTestId = (device: DeviceId): string => `${device}-frame`;

/**
 * The frame's rendered rectangle, after the fly-in has landed — `support/phoneOpen.ts`'s
 * wait, for either device. `boundingBox()` waits for visibility, not for a transform to
 * settle, and a frame arrives on a 500ms `transition:fly`.
 */
export const settledFrameBox = async (page: Page, device: DeviceId) => {
  const frame = page.getByTestId(frameTestId(device));
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  const box = await frame.boundingBox();
  if (!box) throw new Error(`the ${device} frame is not on screen`);
  return box;
};

/** Press the game-scope key that raises or lowers a device, from the device table. */
export const pressDeviceKey = async (page: Page, device: DeviceId): Promise<void> => {
  await page.keyboard.press(DEVICES[device].keybind.defaultKey);
};
