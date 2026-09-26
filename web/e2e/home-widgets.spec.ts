import { test, expect, type Page } from './support/test';
import { gridCellCenter } from './support/homeGrid';
import { settlePhoneOpen } from './support/phoneOpen';

/**
 * Home-screen widgets (MICA-245): added in edit mode, moved with the icons' own long-press
 * drag, persisted with the layout, kept when the grid shrinks, and removed in edit mode.
 */
const seed = async (page: Page, columns: number) => {
  await page.addInitScript((cols: number) => {
    if (window !== window.top) return;
    // Only the first load: the init script runs again on a reload, which would erase what
    // the test just persisted.
    if (window.localStorage.getItem('mica:settings:homeGridItems') !== null) return;
    window.localStorage.setItem(
      'mica:settings:homeGridItems',
      JSON.stringify([{ position: 0, kind: 'app', appId: 'settings' }])
    );
    window.localStorage.setItem('mica:settings:homeGridColumns', String(cols));
  }, columns);
};

const widget = (page: Page) => page.getByTestId('home-widget');
const anchor = async (page: Page) =>
  Number(
    await page
      .locator('[data-position]:has([data-testid="home-widget"])')
      .getAttribute('data-position')
  );

/** Holds a press on an empty cell until the 500ms long-press arms edit mode. */
const enterEditMode = async (page: Page, position: number) => {
  // Measured after the fly-in lands, or the press is aimed at where the cell was.
  await settlePhoneOpen(page);
  const { x, y } = await gridCellCenter(page, position);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.getByTestId('home-edit-bar')).toBeVisible();
  await page.mouse.up();
};

const addClock = async (page: Page) => {
  await page.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('button', { name: 'Clock, Wide' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
};

test.describe('Home widgets', () => {
  test('add, move, reload, shrink the grid, then remove', async ({ page }) => {
    await seed(page, 5);
    await page.goto('/');
    await expect(page.locator('[data-position="0"]')).toBeVisible();

    await enterEditMode(page, 12);
    await addClock(page);
    await expect(widget(page)).toBeVisible();
    // First free 2x1 rectangle after the icon at 0.
    expect(await anchor(page)).toBe(1);

    // Move it with the same long-press drag an icon uses; a widget has no ghost, so the
    // remove target (shown for any removable drag) is the arm signal.
    const box = (await widget(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.getByTestId('remove-drop-target').waitFor({ state: 'visible' });
    const dest = await gridCellCenter(page, 10);
    await page.mouse.move(dest.x, dest.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => anchor(page)).toBe(10);

    await page.reload();
    await expect(widget(page)).toBeVisible();
    expect(await anchor(page)).toBe(10);

    // Shrinking 5 -> 3 columns in Settings keeps it, reflowed to fit.
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await page.locator('button', { hasText: 'Phone size' }).first().click();
    await page.getByRole('button', { name: 'Fewer columns' }).click();
    await page.getByRole('button', { name: 'Fewer columns' }).click();
    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(widget(page)).toBeVisible();
    expect((await anchor(page)) % 3).toBeLessThanOrEqual(1);

    await enterEditMode(page, 8);
    await page.getByRole('button', { name: /Remove widget/ }).click();
    await expect(widget(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-position="0"]')).toBeVisible();
    await expect(widget(page)).toHaveCount(0);
  });

  test('a placed widget survives reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page, 4);
    await page.goto('/');
    await enterEditMode(page, 9);
    await addClock(page);
    await page.reload();
    await expect(widget(page)).toBeVisible();
  });

  test('a tap on the Music widget opens Music, but not in edit mode', async ({ page }) => {
    await seed(page, 4);
    await page.goto('/');
    await enterEditMode(page, 9);
    await page.getByRole('button', { name: 'Add widget' }).click();
    await page.getByRole('button', { name: 'Music, Wide' }).click();
    // Still editing: the widget is inert, so a tap on it opens nothing.
    await expect(page.getByRole('button', { name: 'Remove widget Music' })).toBeVisible();
    await settlePhoneOpen(page);
    await page.getByTestId('home-widget').click({ force: true });
    await expect(page.locator('h1', { hasText: 'Music' })).toBeHidden();
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByTestId('widget-music-empty').click();
    await expect(page.locator('h1', { hasText: 'Music' })).toBeVisible();
  });

  test("tapping Music's own Pause control does not open Music", async ({ page }) => {
    await page.route(/https:\/\/www\.youtube(-nocookie)?\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>s</title>'
      })
    );
    await page.route(/https:\/\/img\.youtube\.com\//, (route) =>
      route.fulfill({ status: 404, body: '' })
    );
    await page.addInitScript(() => {
      if (window !== window.top) return;
      if (window.localStorage.getItem('mica:settings:homeGridItems') !== null) return;
      window.localStorage.setItem(
        'mica:settings:homeGridItems',
        JSON.stringify([{ position: 0, kind: 'widget', widgetId: 'music', size: '2x1' }])
      );
      window.localStorage.setItem('mica:settings:homeGridColumns', '4');
    });
    await page.goto('/');
    await settlePhoneOpen(page);
    await page.getByTestId('widget-music-empty').click();
    const field = page.getByLabel('YouTube link');
    await field.fill('dQw4w9WgXcQ');
    await field.press('Enter');
    await expect(page.locator('button[aria-label="Stop music"]')).toBeVisible();
    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(page.getByTestId('widget-music')).toBeVisible();

    await page.getByTestId('widget-music').getByRole('button', { name: 'Pause' }).click();
    await expect(
      page.getByTestId('widget-music').getByRole('button', { name: 'Play' })
    ).toBeVisible();
    // Apps stay mounted once opened, so "not open" is hidden, not absent.
    await expect(page.locator('h1', { hasText: 'Music' })).toBeHidden();
  });
});
