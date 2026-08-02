import { test, expect } from '@playwright/test';

/**
 * A crashing app must not take the phone down with it.
 *
 * The crashing app is registered at runtime through the dev harness rather than shipped
 * in `apps/` — an app that throws on render would otherwise sit on every player's home
 * screen. `window.appRegistryStore` is assigned by `installDevHarness`.
 *
 * Both tests here used to wrap every assertion in `if ((await btn.count()) > 0)`, and
 * nothing ever assigned `window.appRegistryStore`, so the app was never registered, the
 * count was always 0, and both passed having asserted nothing at all. They did not catch
 * the boundary rendering a blank screen. No conditionals.
 */

const CRASHING_APP = `
  (id, name) => {
    window.appRegistryStore.registerApp(
      { id, name, color: 'bg-red-500', icon: null },
      () => { throw new Error('Simulated third-party app crash!'); }
    );
  }
`;

test.describe('App Isolation & Error Boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('shows the crash fallback and returns home', async ({ page }) => {
    await page.evaluate(`(${CRASHING_APP})('faulty_app', 'Faulty App')`);

    await page.locator('button', { hasText: 'Faulty App' }).click();

    await expect(page.getByText('App Stopped Working')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Return to Home Screen', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart App' })).toBeVisible();

    await page.getByRole('button', { name: 'Return to Home Screen', exact: true }).click();

    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    await expect(page.getByText('App Stopped Working')).toBeHidden();
  });

  test('recovers from a crash using Backspace', async ({ page }) => {
    await page.evaluate(`(${CRASHING_APP})('buggy_app', 'Buggy App')`);

    await page.locator('button', { hasText: 'Buggy App' }).click();

    await expect(page.getByText('App Stopped Working')).toBeVisible();

    // The crashed app never got as far as claiming `back`, so this is the shell's own
    // handler — which is exactly the path a player would hit.
    await page.keyboard.press('Backspace');

    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('the rest of the phone still works after an app crashes', async ({ page }) => {
    await page.evaluate(`(${CRASHING_APP})('broken_app', 'Broken App')`);

    await page.locator('button', { hasText: 'Broken App' }).click();
    await expect(page.getByText('App Stopped Working')).toBeVisible();

    await page.getByRole('button', { name: 'Return to Home Screen', exact: true }).click();

    // The point of per-app isolation: one app's crash must leave the others openable.
    await page.locator('button', { hasText: 'Calculator' }).click();
    await expect(page.getByText('App Stopped Working')).toBeHidden();
    await expect(page.getByRole('button', { name: '7' })).toBeVisible();
  });
});
