import { test, expect, type Page, type FrameLocator } from './support/test';
import { seedHomeGrid } from './support/homeGrid';
import { addOnFrame, dismissToasts, installAddOn } from './support/addon';

/**
 * Streamer mode (MICA-249): every player-supplied picture is blurred until tapped.
 *
 * One implementation in `sdk/ui/MediaThumb`, so one test per surface that renders through
 * it is what proves the mode reaches the places a streamer is worried about — a thread
 * attachment, the gallery, a listing photo, and a Blab's picture, that last one inside a
 * `core: false` add-on's sandboxed frame, which is the add-on path of the flag end to end.
 *
 * What is asserted is the *state*, through the `data-streamer` attribute the thumb
 * announces, never a computed `filter`: Playwright's Chromium is not CEF, and a blur it
 * can measure says nothing about the one in game. The attribute is what the mode decided;
 * the pixels are `blur-media`'s and CEF's.
 *
 * Mail has no picture surface and Blabber's DMs are text, so neither appears here.
 */

const KEY = 'mica:settings:streamerMode';

/** The flag as the settings service would hand it back for this character. */
const seedStreamerMode = (page: Page) =>
  page.addInitScript((key: string) => {
    // Shell document only: an add-on frame has an opaque origin where this throws (MICA-206).
    if (window !== window.top) return;
    window.localStorage.setItem(key, 'true');
  }, KEY);

const blurred = (scope: Page | FrameLocator) => scope.locator('[data-streamer="blurred"]');
const revealed = (scope: Page | FrameLocator) => scope.locator('[data-streamer="revealed"]');
const revealButton = (scope: Page | FrameLocator) =>
  scope.getByRole('button', { name: 'Tap to reveal' });

test.describe('the switch', () => {
  test('lives on Privacy, starts off, and stays on across a reload', async ({ page }) => {
    await seedHomeGrid(page, ['settings']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'About' }).first().click();
    await page.locator('button', { hasText: 'Privacy' }).first().click();
    await expect(page.locator('h1', { hasText: 'Privacy' })).toBeVisible();

    const toggle = page.getByRole('switch', { name: 'Streamer Mode' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The same `settings` namespace every other toggle in the app writes to, which is
    // what carries it to the settings service and back per character.
    expect(await page.evaluate((key) => window.localStorage.getItem(key), KEY)).toBe('true');

    await page.reload();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'About' }).first().click();
    await page.locator('button', { hasText: 'Privacy' }).first().click();
    await expect(page.getByRole('switch', { name: 'Streamer Mode' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('off means no picture carries the attribute at all', async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Media' }).first().click();
    await expect(page.getByRole('button', { name: /^Open photo \d+$/ }).first()).toBeVisible();
    await expect(page.locator('[data-streamer]')).toHaveCount(0);
  });
});

test.describe('with streamer mode on', () => {
  test.beforeEach(async ({ page }) => {
    await seedStreamerMode(page);
  });

  test('Media: the gallery is blurred, a tap reveals without opening, and leaving re-blurs', async ({
    page
  }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Media' }).first().click();
    const tiles = page.getByRole('button', { name: /^Open photo \d+$/ });
    await expect(tiles.first()).toBeVisible();

    // Only a tile with a still is blurred: the fixture gallery also holds a voice note and
    // a file, which draw a labelled placeholder and have no picture to hide.
    const stills = tiles.filter({ has: page.locator('img') });
    const count = await stills.count();
    expect(count).toBeGreaterThan(0);
    await expect(blurred(page)).toHaveCount(count);
    await expect(revealed(page)).toHaveCount(0);

    // The first tap is the reveal and nothing else: the grid tile is a button that opens
    // the photo, and the mode exists to keep the full-size original off screen.
    await revealButton(page).first().click();
    await expect(revealed(page)).toHaveCount(1);
    await expect(blurred(page)).toHaveCount(count - 1);
    await expect(page.getByRole('button', { name: 'Delete photo' })).toHaveCount(0);

    // The second tap opens it. The detail view replaces the grid and is a fresh thumb,
    // so the one picture on screen is blurred again.
    await tiles.first().click();
    await expect(page.getByRole('button', { name: 'Delete photo' })).toBeVisible();
    await expect(blurred(page)).toHaveCount(1);
    await expect(revealed(page)).toHaveCount(0);
    await page.keyboard.press('Backspace');
    await expect(tiles.first()).toBeVisible();

    // Leaving the app. The grid stays mounted while Media is backgrounded (apps are
    // resident), so the reveal has to be undone by the foreground app changing.
    await revealButton(page).first().click();
    await expect(revealed(page)).toHaveCount(1);
    await page.locator("button[aria-label='Return to home screen']").click();
    await page.locator('button', { hasText: 'Media' }).first().click();
    await expect(tiles.first()).toBeVisible();
    await expect(revealed(page)).toHaveCount(0);
    await expect(blurred(page)).toHaveCount(count);
  });

  test('Messages: every attachment in a thread is blurred until tapped', async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Messages' }).first().click();
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    const thread = page.locator('#messages-container');
    await expect(thread).toBeVisible();
    // Attachments sit on every twenty-fifth message; the same three clicks
    // `messages.spec.ts` uses fetch the rest of the thread deterministically.
    for (let i = 0; i < 3; i += 1) {
      await thread.locator('button', { hasText: 'Load older messages' }).dispatchEvent('click');
    }
    await expect(thread.locator('button', { hasText: 'Load older messages' })).not.toBeVisible();

    const slots = thread.locator('[data-testid="attachment-slot"]');
    await expect(slots.first()).toBeVisible();
    const slotCount = await slots.count();
    await expect(
      thread.locator('[data-testid="attachment-slot"] [data-streamer="blurred"]')
    ).toHaveCount(slotCount);

    await slots.first().getByRole('button', { name: 'Tap to reveal' }).click();
    await expect(slots.first().locator('[data-streamer="revealed"]')).toHaveCount(1);
    await expect(
      thread.locator('[data-testid="attachment-slot"] [data-streamer="blurred"]')
    ).toHaveCount(slotCount - 1);
  });

  test('Snatchr: the photo picker on a new listing is blurred until tapped', async ({ page }) => {
    // The only picture surface Snatchr has in the browser mock. `marketplace:create` in
    // `nui/mocks/registry.ts` answers with `attachments: []` whatever was picked, and the
    // fixture listings ship without photos, so neither the feed card nor the listing
    // detail ever draws a `MediaThumb` here — both go through it in the app, and both
    // wait on the mock carrying attachments before a spec can reach them.
    await seedHomeGrid(page, ['marketplace']);
    await page.goto('/');
    await page.getByRole('button', { name: /Snatchr/ }).click();
    await page.getByRole('button', { name: 'Create listing' }).click();
    await page.getByRole('button', { name: /Add photos/ }).click();
    const picker = page.locator('div.z-30', { has: page.getByRole('button', { name: /^Done/ }) });
    await expect(blurred(picker).first()).toBeVisible();
    await expect(revealed(picker)).toHaveCount(0);

    // A blurred tile takes two taps, one to see what it is and one to pick it. Matched on
    // the attribute being present, not on `blurred`: the reveal flips it to `revealed`, and
    // a locator pinned to `blurred` would slide to the next tile. The fixture gallery leads
    // with rows that have no picture, which is why it is not simply the first tile.
    const tile = picker
      .locator('button.aspect-square', { has: page.locator('[data-streamer]') })
      .first();
    await tile.getByRole('button', { name: 'Tap to reveal' }).click();
    await expect(revealed(picker)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Add photos (0/4)' })).toBeVisible();
    await tile.click();
    await expect(page.getByRole('button', { name: 'Add photos (1/4)' })).toBeVisible();
  });

  test('Blabber: an add-on in its sandboxed frame honours the flag over the seam', async ({
    page
  }) => {
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await installAddOn(page, 'Blabber');
    await page.getByRole('button', { name: /Blabber/ }).click();
    await dismissToasts(page);

    const frame = addOnFrame(page, 'blabber');
    await expect(frame.locator('h1', { hasText: 'Blabber' })).toBeVisible();
    await frame.getByRole('button', { name: 'Blab', exact: true }).click();
    await frame.locator('textarea').fill('pictured');
    await frame.getByRole('button', { name: 'Attach photo' }).click();
    // A `core: false` bundle draws with the iframe twin of the same primitive, so the
    // picker inside the frame is blurred too — the flag crossed the seam.
    await expect(blurred(frame).first()).toBeVisible();
    const tile = frame
      .locator('button.aspect-square', { has: frame.locator('[data-streamer]') })
      .first();
    await tile.getByRole('button', { name: 'Tap to reveal' }).click();
    await tile.click();
    await expect(frame.getByRole('button', { name: 'Remove attachment' })).toBeVisible();
    await frame.getByRole('button', { name: /^Done/ }).click();
    await frame.getByRole('button', { name: 'Post', exact: true }).click();

    const row = frame.locator('article', { hasText: 'pictured' });
    await expect(row).toBeVisible();
    await expect(blurred(row)).toHaveCount(1);
    await row.getByRole('button', { name: 'Tap to reveal' }).click();
    await expect(revealed(row)).toHaveCount(1);
    await expect(blurred(row)).toHaveCount(0);
  });
});
