import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * Owner branding (MICA-236): the phone body's variants and the owner's wallpapers, chosen in
 * Settings > Display. The mock's `shell:ownerConfig` offers one wallpaper.
 */
test.describe('Owner branding', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['settings']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.getByRole('button', { name: /^Display\b/ }).click();
    await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();
  });

  for (const variant of ['classic', 'notch', 'punch'] as const) {
    test(`the ${variant} frame keeps the screen box and clears the status bar`, async ({
      page
    }) => {
      const picker = page.getByTestId('frame-picker');
      const label = { classic: 'Classic', notch: 'Notch', punch: 'Punch-hole' }[variant];
      await picker.getByRole('button', { name: label }).click();

      const frame = page.getByTestId('phone-frame');
      await expect(frame).toHaveAttribute('data-frame-variant', variant);

      // The frame is drawn at whatever zoom the window allows; divide it back out.
      const box = await frame.boundingBox();
      if (!box) throw new Error('the phone is not on screen');
      const scale = box.width / 400;
      expect(box.height / scale).toBeCloseTo(850, 0);

      const screen = await page.getByTestId('phone-screen').boundingBox();
      if (!screen) throw new Error('the screen is not on screen');
      expect(screen.width / scale).toBeCloseTo(384, 0);
      expect(screen.height / scale).toBeCloseTo(834, 0);

      // The status bar's clock (left) ends before the cutout starts.
      const cutout = await page.getByTestId('camera-cutout').boundingBox();
      const clock = await frame
        .locator('button[aria-label*="notification shade"] span')
        .first()
        .boundingBox();
      if (!cutout || !clock) throw new Error('the status bar or cutout is not on screen');
      expect(clock.x + clock.width).toBeLessThan(cutout.x);
    });
  }

  test('the frame choice survives a reload; the colour changes the body', async ({ page }) => {
    const picker = page.getByTestId('frame-picker');
    await picker.getByRole('button', { name: 'Notch' }).click();
    await picker.getByRole('button', { name: 'Silver' }).click();
    await expect(page.getByTestId('phone-frame')).toHaveAttribute(
      'style',
      /border-color: rgb\(209, 213, 219\)/
    );
    await page.reload();
    await expect(page.getByTestId('phone-frame')).toHaveAttribute('data-frame-variant', 'notch');
  });

  test("an owner's wallpaper is offered and can be chosen", async ({ page }) => {
    const tiles = page.getByTestId('owner-wallpapers').getByRole('button');
    await expect(tiles).toHaveCount(1);
    await tiles.first().click();
    await expect(tiles.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('phone-screen')).toHaveAttribute(
      'style',
      /mock-branding\/aurora\.svg/
    );
  });
});
