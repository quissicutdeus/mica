import { test, expect } from '@playwright/test';

/**
 * Opening a demo catalogue app.
 *
 * The four entries in the Store's catalogue — Chirper, Crypto Tracker, Downtown Taxi,
 * Marketplace — have no code in this repo. They exist so the Store has something to show.
 * Installing one therefore had nothing to register, and the Store handed the registry a
 * plain `{ name, type }` object in place of a component: tapping the icon afterwards ran
 * straight into `ErrorBoundary` and told the player the app had crashed.
 *
 * It has not crashed. It was never there.
 */
test.describe('a demo catalogue app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Store' }).first().click();
    await expect(page.locator('h1', { hasText: 'Store' })).toBeVisible();
    await page
      .locator('div.rounded-xl', { hasText: 'Crypto Tracker' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Back to Home']").click();
  });

  test('says it is not part of this build, rather than that it crashed', async ({ page }) => {
    await page.getByRole('button', { name: /Crypto Tracker/ }).click();

    await expect(page.getByText(/not part of this build/i)).toBeVisible();
    // The distinction the whole test exists for.
    await expect(page.getByText('App Stopped Working')).toHaveCount(0);
  });

  test('names the app it stood in for', async ({ page }) => {
    // Generic copy would leave the player guessing which icon misbehaved, and the manifest
    // is right there in the registry.
    await page.getByRole('button', { name: /Crypto Tracker/ }).click();

    await expect(page.locator('h1', { hasText: 'Crypto Tracker' })).toBeVisible();
  });

  test('leaves by the back button like any other app', async ({ page }) => {
    // It is mounted as a real app, so the ordinary way out has to work — otherwise the
    // placeholder is its own kind of trap.
    await page.getByRole('button', { name: /Crypto Tracker/ }).click();
    await expect(page.getByText(/not part of this build/i)).toBeVisible();

    await page.locator("button[aria-label='Go back']").click();

    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });
});
