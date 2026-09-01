import { test, expect } from '../support/test';

test.describe('Camera App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Camera' }).first().click();
    await expect(page.locator('button[aria-label="Take photo"]')).toBeVisible();
  });

  test('renders Camera viewfinder and capture button', async ({ page }) => {
    const takePhotoBtn = page.locator('button[aria-label="Take photo"]');
    await expect(takePhotoBtn).toBeVisible();

    const goBackBtn = page.locator('button[aria-label="Go back"]');
    await expect(goBackBtn).toBeVisible();
  });

  /**
   * MICA-79. The region this measures is the one the photo is cropped to — the app reads
   * its `getBoundingClientRect()` and cuts the capture to it — so a landscape-shaped box
   * here is the same claim as a landscape photo, rather than a viewfinder that merely looks
   * the part.
   */
  test('LANDSCAPE reframes the capture region to a landscape box', async ({ page }) => {
    const region = page.getByTestId('camera-capture-region');

    const portrait = await region.boundingBox();
    expect(portrait).not.toBeNull();
    expect(portrait!.height).toBeGreaterThan(portrait!.width);

    await page.getByRole('button', { name: 'LANDSCAPE', exact: true }).click();

    const landscape = await region.boundingBox();
    expect(landscape).not.toBeNull();
    expect(landscape!.width).toBeGreaterThan(landscape!.height);
    // 16:9, the same ratio `.aspect-video` and `LANDSCAPE_ASPECT` both name.
    expect(landscape!.width / landscape!.height).toBeCloseTo(16 / 9, 1);
    // The frame narrows what is being shot; it must not widen the phone.
    expect(landscape!.width).toBeCloseTo(portrait!.width, 0);
  });

  test('VIDEO stays disabled — there is no recording pipeline behind it', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'VIDEO', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'LANDSCAPE', exact: true })).toBeEnabled();
  });
});
