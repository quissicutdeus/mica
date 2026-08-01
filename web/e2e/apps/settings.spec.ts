import { test, expect } from '@playwright/test';

test.describe('Settings App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  });

  test('the root is nothing but groups — 24-hour time lives under Display', async ({ page }) => {
    // Nothing is settable from the root itself.
    await expect(page.locator('button[aria-label="Toggle 24-hour time"]')).toHaveCount(0);

    await page.locator('button', { hasText: 'Display' }).first().click();
    await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();

    const toggleSwitch = page.locator('button[aria-label="Toggle 24-hour time"]');
    await expect(toggleSwitch).toBeVisible();
    await toggleSwitch.click();
    await toggleSwitch.click();

    // And Backspace steps back up to the hub rather than leaving Settings.
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  });

  test('displays About sub-page with phone number, OS name, first boot date, and smart versioning info', async ({
    page
  }) => {
    await page.locator('button', { hasText: 'About' }).first().click();
    await expect(page.locator('h1', { hasText: 'About' })).toBeVisible();

    await expect(page.locator('text=Phone Number')).toBeVisible();
    await expect(page.locator('text=gPhone')).toBeVisible();
    await expect(page.locator('text=867-5309')).toBeVisible();
    await expect(page.locator('text=First Boot')).toBeVisible();
  });

  test('back from a sub-page returns to the Settings hub, not the home screen', async ({
    page
  }) => {
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Shortcuts' })).toBeVisible();

    await page.locator("button[aria-label='Go back']").click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

    // A second back leaves the app entirely.
    await page.locator("button[aria-label='Go back']").click();
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('Backspace steps up one pane before leaving the app', async ({ page }) => {
    await page.locator('button', { hasText: 'Shortcuts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Shortcuts' })).toBeVisible();

    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    // And the shell's own handler is back: Backspace still works after Settings unmounts.
    await page.locator('button', { hasText: 'Calculator' }).first().click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('Developer Tools stays hidden until ten taps on OS Version', async ({ page }) => {
    // Same in a browser as in game: the row is not there until it is earned.
    await expect(page.locator('button', { hasText: 'Developer Tools' })).toHaveCount(0);

    await page.locator('button', { hasText: 'About' }).first().click();
    const buildRow = page.locator('button', { hasText: 'OS Version' });
    for (let i = 0; i < 10; i++) await buildRow.click();

    await page.locator("button[aria-label='Go back']").click();
    const devRow = page.locator('button', { hasText: 'Developer Tools' });
    await expect(devRow).toBeVisible();

    await devRow.click();
    await expect(page.locator('h1', { hasText: 'Developer Tools' })).toBeVisible();
    await expect(page.locator('text=Battery Charge')).toBeVisible();
  });

  test('the Developer Tools toggle re-locks the group', async ({ page }) => {
    await page.locator('button', { hasText: 'About' }).first().click();
    const buildRow = page.locator('button', { hasText: 'OS Version' });
    for (let i = 0; i < 10; i++) await buildRow.click();
    await page.locator("button[aria-label='Go back']").click();

    await page.locator('button', { hasText: 'Developer Tools' }).click();
    const toggle = page.locator("button[aria-label='Toggle Developer Tools']");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Developer Tools' })).toHaveCount(0);
  });

  test('the unlock is not persisted — a fresh session hides it again', async ({ page }) => {
    await page.locator('button', { hasText: 'About' }).first().click();
    const buildRow = page.locator('button', { hasText: 'OS Version' });
    for (let i = 0; i < 10; i++) await buildRow.click();
    await page.locator("button[aria-label='Go back']").click();
    await expect(page.locator('button', { hasText: 'Developer Tools' })).toBeVisible();

    // It survives leaving and re-entering the app — App.svelte re-keys on the active
    // app, so a component-local flag would have been lost here.
    await page.locator("button[aria-label='Go back']").click();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('button', { hasText: 'Developer Tools' })).toBeVisible();

    // It does not survive a fresh load. A stored flag is what made it show up on a
    // phone nobody had tapped.
    await page.reload();
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('button', { hasText: 'Developer Tools' })).toHaveCount(0);
  });
});
