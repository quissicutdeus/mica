// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * The Places map and live location sharing (MICA-244), against the mock transport.
 *
 * The mock stands in for a friend: `places:live` always answers with Ursula sharing, walking
 * a slow circle, so the map has something that moves. It proves the UI polls, draws and
 * pans — not that the server samples a real ped, which only the game can show.
 */
test.describe('Places map', () => {
  const openPlaces = async (page: Page) => {
    await seedHomeGrid(page, ['places']);
    await page.goto('/');
    await page.getByRole('button', { name: 'Places' }).click();
    await expect(page.getByTestId('places-map')).toBeVisible();
  };

  const pinX = async (page: Page, testId: string) =>
    Number(await page.getByTestId(testId).first().getAttribute('data-x'));

  /** Work, the saved place a few hundred metres from where the mock stands you. */
  const workX = async (page: Page) =>
    Number(await page.getByTestId('places-pin-place').last().getAttribute('data-x'));

  test('draws the neutral grid when no map image is configured', async ({ page }) => {
    await openPlaces(page);
    await expect(page.getByTestId('places-map-grid')).toBeAttached();
    await expect(page.getByTestId('places-map-image')).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'You' })).toBeAttached();
  });

  test('shows a friend sharing with you, named from contacts, and follows them', async ({
    page
  }) => {
    await openPlaces(page);
    const friend = page.getByTestId('places-pin-friend');
    await expect(friend).toHaveAttribute('aria-label', 'Ursula (Crazy Ex)');

    const first = await pinX(page, 'places-pin-friend');
    await expect.poll(() => pinX(page, 'places-pin-friend'), { timeout: 8_000 }).not.toBe(first);
  });

  test('pans with a pointer drag', async ({ page }) => {
    await openPlaces(page);
    await expect(page.getByTestId('places-pin-self')).toBeAttached();
    const before = await pinX(page, 'places-pin-self');

    const box = await page.getByTestId('places-map').boundingBox();
    if (!box) throw new Error('the map has no box');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y - 30, { steps: 6 });
    await page.mouse.up();

    await expect.poll(() => pinX(page, 'places-pin-self')).toBeLessThan(before - 20);
  });

  /**
   * MICA-294. Putting the phone away leaves Places the current app, and in a browser the
   * frame's outro never completes (`keybinds.spec.ts`), so Places stays mounted too — before
   * `useAppVisible` it kept reading `places:live` every interval with nobody looking. The mock
   * interval is 2s, so the wait below spans two and a half of them.
   */
  test('stops reading live positions while the phone is away, and reads again on reopen', async ({
    page
  }) => {
    const liveReads = () =>
      page.evaluate(
        () => (window.mockCalls ?? []).filter((call) => call.event === 'places:live').length
      );
    await openPlaces(page);
    const opened = await liveReads();
    await expect.poll(liveReads, { timeout: 5_000 }).toBeGreaterThan(opened);

    await page.evaluate(() => window.postMessage({ action: 'setVisible', data: false }, '*'));
    await expect(page.getByRole('button', { name: /Open micaOS/i })).toBeVisible();
    const closed = await liveReads();
    await page.waitForTimeout(5_000);
    expect(await liveReads()).toBe(closed);

    // Reopened, it reads at once rather than waiting out an interval.
    await page.evaluate(() => window.postMessage({ action: 'setVisible', data: true }, '*'));
    await expect.poll(liveReads, { timeout: 1_500 }).toBeGreaterThan(closed);
  });

  test('zooms with the buttons', async ({ page }) => {
    await openPlaces(page);
    await expect(page.getByTestId('places-pin-place')).toHaveCount(2);
    await expect(page.getByTestId('places-pin-self')).toBeAttached();
    const self = await pinX(page, 'places-pin-self');
    const place = await workX(page);
    const spread = Math.abs(place - self);

    await page.getByRole('button', { name: 'Zoom in' }).click();

    await expect
      .poll(async () => Math.abs((await workX(page)) - (await pinX(page, 'places-pin-self'))))
      .toBeGreaterThan(spread);
  });

  test('shares live location with a chosen contact, shows it, and stops', async ({ page }) => {
    await openPlaces(page);
    await page.getByRole('button', { name: 'Share Live Location' }).click();

    await page.getByRole('checkbox', { name: /Ursula/ }).click();
    await page.getByRole('button', { name: 'Start Sharing' }).click();

    const indicator = page.getByTestId('places-sharing-indicator');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Sharing live location with 1');
    // And in the status bar, where it is visible from every app (the server's push).
    await expect(page.getByTestId('status-live-location')).toBeVisible();

    await indicator.getByRole('button', { name: 'Stop' }).click();
    await expect(indicator).toHaveCount(0);
    await expect(page.getByTestId('status-live-location')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share Live Location' })).toBeVisible();
  });
});
