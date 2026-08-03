import { test, expect } from '@playwright/test';

/**
 * `?app=<id>` — the dev deep link.
 *
 * Booting into an app used to be impossible: `main.ts` mounts the shell and nothing
 * else, so every look at an app went through the launcher. These assert the inner loop
 * an app author actually runs, and that a bad id fails loudly instead of blankly.
 */
test.describe('?app= deep link', () => {
  test('boots straight into an app, without touching the launcher', async ({ page }) => {
    await page.goto('/?app=calculator');

    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
  });

  test('opens an app that is not installed by default', async ({ page }) => {
    // Notes ships `isSystem: false`, so it is absent from the launcher until it is
    // installed from the Store. Resolving against the component registry is what makes
    // this work, and it is the case `notes.spec.ts` pays for on every run.
    await page.goto('/?app=notes');

    await expect(page.locator('h1', { hasText: 'Notes' })).toBeVisible();
  });

  test('is case-insensitive, matching how openApp resolves', async ({ page }) => {
    await page.goto('/?app=Calculator');

    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
  });

  test('warns and stays home on an unknown id, rather than rendering nothing', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    await page.goto('/?app=nosuchapp');

    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    expect(warnings.some((w) => w.includes('nosuchapp'))).toBe(true);
  });

  test('leaves the phone on the home screen when the param is absent', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });
});
