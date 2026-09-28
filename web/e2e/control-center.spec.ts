import { test, expect, type Page } from './support/test';
import { DEVICES } from '@mica/shared/devices';

/**
 * The control center (MICA-247): the switches, brightness, volume and the music tray on a
 * sheet of their own, opened by pulling down from the right-hand part of the status bar.
 * The left keeps the notification shade — `notifications.spec.ts` covers that side.
 */

const PHONE_WIDTH = DEVICES.phone.frame.width;

const frameBox = async (page: Page) => {
  const frame = page.getByTestId('phone-frame');
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  const box = await frame.boundingBox();
  if (!box) throw new Error('the phone frame is not on screen');
  return box;
};

/** Pull down from `fraction` of the way across the status bar. */
const pullStatusBar = async (page: Page, fraction: number) => {
  const box = await frameBox(page);
  const scale = box.width / PHONE_WIDTH;
  const bar = await page.getByRole('button', { name: 'Open notification shade' }).boundingBox();
  if (!bar) throw new Error('status bar not on screen');
  const x = bar.x + bar.width * fraction;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + scale * 700, { steps: 8 });
  await page.mouse.up();
};

const openControlCenter = async (page: Page) => {
  await pullStatusBar(page, 0.85);
  const cc = page.getByRole('dialog', { name: 'Control Center' });
  await expect(cc).toBeVisible();
  await expect
    .poll(async () => cc.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  return cc;
};

test.describe('Control center', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();
  });

  test('a pull from the right of the status bar opens it, and the left still opens the shade', async ({
    page
  }) => {
    await openControlCenter(page);
    await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close Control Center' }).click();
    await expect(page.getByRole('dialog', { name: 'Control Center' })).toHaveCount(0);

    await pullStatusBar(page, 0.3);
    await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Control Center' })).toHaveCount(0);
  });

  test('the shade no longer carries the toggle row, and links to the control center', async ({
    page
  }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await expect(shade).toBeVisible();
    await expect(shade.getByRole('button', { name: 'Airplane' })).toHaveCount(0);
    await shade.getByRole('button', { name: 'Open Control Center' }).click();
    await expect(page.getByRole('dialog', { name: 'Control Center' })).toBeVisible();
    await expect(shade).toHaveCount(0);
  });

  test('airplane mode toggles, and locks the radios off', async ({ page }) => {
    const cc = await openControlCenter(page);
    const airplane = cc.getByTestId('cc-toggle-airplane');
    await expect(airplane).toHaveAttribute('aria-pressed', 'false');
    await airplane.click();
    await expect(airplane).toHaveAttribute('aria-pressed', 'true');
    await expect(cc.getByTestId('cc-toggle-bluetooth')).toBeDisabled();
    await airplane.click();
    await expect(airplane).toHaveAttribute('aria-pressed', 'false');
    await expect(cc.getByTestId('cc-toggle-bluetooth')).toBeEnabled();
  });

  test('a reordered and hidden toggle survives a reload', async ({ page }) => {
    let cc = await openControlCenter(page);
    const order = async () =>
      cc
        .getByTestId('control-center-toggles')
        .locator('[data-testid^="cc-toggle-"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));

    await cc.getByTestId('control-center-edit').click();
    await cc.getByRole('button', { name: 'Move Flashlight earlier' }).click();
    await cc.getByRole('button', { name: 'Hide Bluetooth' }).click();
    // Edit mode still lists a hidden toggle, so it can be shown again.
    expect(await order()).toContain('cc-toggle-bluetooth');
    await cc.getByTestId('control-center-edit').click();
    await expect(cc.getByTestId('cc-toggle-bluetooth')).toHaveCount(0);
    const before = await order();
    expect(before.indexOf('cc-toggle-flashlight')).toBeLessThan(before.indexOf('cc-toggle-dnd'));

    // The layout is written through a debounced save (`settingsSync.ts`'s 400ms), to
    // `localStorage` under the mock transport's own key — poll that rather than guessing
    // at a delay long enough to outlast it.
    await expect
      .poll(async () =>
        page.evaluate(() => localStorage.getItem('mica:settings:controlCenterLayout'))
      )
      .toMatch(/"bluetooth"/);
    await page.reload();
    await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();
    cc = await openControlCenter(page);
    await expect(cc.getByTestId('cc-toggle-bluetooth')).toHaveCount(0);
    expect(await order()).toEqual(before);
  });

  test('the volume slider moves the volume', async ({ page }) => {
    const cc = await openControlCenter(page);
    await cc.getByTestId('cc-volume').fill('30');
    await expect(cc.getByTestId('cc-volume-percent')).toHaveText('30%');
    await cc.getByTestId('cc-volume').fill('70');
    await expect(cc.getByTestId('cc-volume-percent')).toHaveText('70%');
  });

  test('brightness dims the screen', async ({ page }) => {
    const cc = await openControlCenter(page);
    await expect(page.getByTestId('brightness-dim')).toHaveCount(0);
    await cc.getByTestId('cc-brightness').fill('50');
    await expect(page.getByTestId('brightness-dim')).toBeAttached();
    await cc.getByTestId('cc-brightness').fill('100');
    await expect(page.getByTestId('brightness-dim')).toHaveCount(0);
  });
});
