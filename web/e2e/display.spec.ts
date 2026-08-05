import { test, expect, type Page } from '@playwright/test';

/**
 * The phone is one shape drawn at many sizes.
 *
 * Playwright drives a modern Chromium at 1280x960, which is exactly the window this
 * suite could never have caught the original defect in: 850px of phone fits there and
 * nowhere near fits a phone-sized browser window. So these tests resize the viewport
 * deliberately rather than trusting the default.
 */

const DESIGN_WIDTH = 400;
const DESIGN_HEIGHT = 850;
const DESIGN_RATIO = DESIGN_WIDTH / DESIGN_HEIGHT;

/**
 * The frame's rendered rectangle, after the fly-in has landed.
 *
 * `boundingBox()` waits for visibility, not for a transform to settle, and the phone
 * arrives on a 500ms `transition:fly` — reading it mid-flight gives a `y` a thousand
 * pixels below the window and a test that fails for the wrong reason.
 */
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

const openDisplayPane = async (page: Page) => {
  await page.locator('button', { hasText: 'Settings' }).first().click();
  await page.locator('button', { hasText: 'Phone size' }).first().click();
  await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();
};

test('the shipped default draws the design size, so an existing player sees no change', async ({
  page
}) => {
  await page.goto('/');
  const box = await frameBox(page);
  expect(box.width).toBeCloseTo(DESIGN_WIDTH, 0);
  expect(box.height).toBeCloseTo(DESIGN_HEIGHT, 0);
});

test('scales down to fit a phone-sized window instead of running off the bottom', async ({
  page
}) => {
  // A mid-size Android in portrait, with the browser chrome taken out.
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/');

  const box = await frameBox(page);

  // The whole phone, top and bottom, inside the window.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(664);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  // Smaller, and still the same phone.
  expect(box.height).toBeLessThan(DESIGN_HEIGHT);
  expect(box.width / box.height).toBeCloseTo(DESIGN_RATIO, 2);

  // The home indicator is the bottom-most thing on the screen; if the frame fits, it is
  // reachable. It is also what a cut-off phone loses first.
  await expect(page.getByRole('button', { name: 'Return to home screen' })).toBeVisible();
});

test('nothing overflows the document at a phone-sized window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/');

  const overflow = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test('the Display setting resizes the phone, keeps its shape, and survives a reload', async ({
  page
}) => {
  await page.goto('/');
  await openDisplayPane(page);

  const slider = page.getByLabel('Phone size');
  await expect(slider).toHaveValue('50');

  await slider.fill('0');
  const small = await frameBox(page);
  expect(small.height).toBeLessThan(DESIGN_HEIGHT);
  expect(small.width / small.height).toBeCloseTo(DESIGN_RATIO, 2);

  await slider.fill('100');
  const large = await frameBox(page);
  expect(large.height).toBeGreaterThan(small.height);
  expect(large.width / large.height).toBeCloseTo(DESIGN_RATIO, 2);

  // 1280x960 cannot hold 1190px of phone, so the top of the range is the window's to
  // decide — and Settings says so rather than looking like a dead control.
  await expect(page.locator('text=Limited by the size of this window')).toBeVisible();

  await slider.fill('20');
  const chosen = await frameBox(page);

  await page.reload();
  expect((await frameBox(page)).height).toBeCloseTo(chosen.height, 0);

  // And Reset puts it back.
  await openDisplayPane(page);
  await page.locator('button', { hasText: 'Reset to Default' }).click();
  expect((await frameBox(page)).height).toBeCloseTo(DESIGN_HEIGHT, 0);
});

test('dragging a list tracks the cursor at a reduced size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/');
  // Contacts, because the list has to be longer than the screen for there to be anything
  // to drag: the phone's *layout* is still 850px tall however small it is drawn.
  await page.locator('button', { hasText: 'Contacts' }).first().click();
  await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
  await frameBox(page);

  const scroller = page.locator('[data-testid="phone-screen"] .overflow-y-auto').first();
  const box = await scroller.boundingBox();
  if (!box) throw new Error('nothing to scroll');

  const startY = box.y + box.height - 20;
  const travel = 80;

  await page.mouse.move(box.x + box.width / 2, startY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, startY - travel, { steps: 8 });
  await page.mouse.up();

  /**
   * The content must move as far as the cursor did, not as far as the cursor did times
   * the zoom. `scrollTop` is in the element's own unscaled pixels while `clientX/Y` are
   * on-screen ones, so applied 1:1 a phone drawn at 75% visibly lagged behind the grab.
   * Compared against the *rendered* travel, which is what a hand expects.
   */
  const scrolled = await scroller.evaluate((el) => el.scrollTop);
  const scale = await scroller.evaluate((el) => {
    const rendered = el.getBoundingClientRect().width;
    return rendered > 0 && (el as HTMLElement).offsetWidth > 0
      ? rendered / (el as HTMLElement).offsetWidth
      : 1;
  });
  expect(scale).toBeLessThan(1);
  expect(scrolled * scale).toBeGreaterThan(travel * 0.8);
});
