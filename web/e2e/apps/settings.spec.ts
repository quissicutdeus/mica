import { test, expect } from '@playwright/test';

test.describe('Settings App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Settings' }).first().click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  });

  test('the root is nothing but groups — 24-hour time lives under Display', async ({ page }) => {
    // Nothing is settable from the root itself.
    await expect(page.getByRole('switch')).toHaveCount(0);

    await page.locator('button', { hasText: 'Display' }).first().click();
    await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();

    // A switch, announced as one: `ToggleSwitch` carries `role="switch"` and its visible
    // label is its accessible name. The hand-inlined version this replaced was an
    // unlabelled `<div>` inside a button called "Toggle 24-hour time".
    const toggleSwitch = page.getByRole('switch', { name: '24-Hour Time' });
    await expect(toggleSwitch).toBeVisible();
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false');
    await toggleSwitch.click();
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true');
    await toggleSwitch.click();
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false');

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
    const toggle = page.getByRole('switch', { name: 'Developer Tools' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

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

  /**
   * Settings > Apps: what is installed, and the two things you can do to it.
   *
   * Deliberately overlapping with the Store on uninstall and nothing else. Uninstalling runs the
   * registry's own `unregisterApp` — the same call the Store makes — so there is one removal path
   * rather than two that can disagree about what gets cleaned up.
   */
  test.describe('Apps', () => {
    const openApps = async (page: import('@playwright/test').Page) => {
      await page.locator('button', { hasText: 'Storage and uninstall' }).click();
      await expect(page.locator('h1', { hasText: 'Apps' })).toBeVisible();
    };

    test('lists system apps and add-ons, and drills into one', async ({ page }) => {
      await openApps(page);

      // Core apps are in the registry from boot; the group heading is what separates them.
      await expect(page.locator('text=System').first()).toBeVisible();
      await page.locator('button', { hasText: 'Contacts' }).first().click();

      await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
      await expect(page.locator('text=System apps ship with the phone')).toBeVisible();
      // No Uninstall for a core app rather than one that could only fail — `unregisterApp`
      // throws for a core id.
      await expect(page.getByRole('button', { name: 'Uninstall' })).toHaveCount(0);
    });

    test('Back steps out of an app before leaving the pane', async ({ page }) => {
      // The details page is its own `useAppLevels` rung. Without it Back jumped from an app
      // straight to the Settings root, skipping the list it came from.
      await openApps(page);
      await page.locator('button', { hasText: 'Contacts' }).first().click();
      await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();

      await page.keyboard.press('Backspace');
      await expect(page.locator('h1', { hasText: 'Apps' })).toBeVisible();

      await page.keyboard.press('Backspace');
      await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    });

    test('clears an app’s storage and resets what it was holding', async ({ page }) => {
      /**
       * Sound writes `volumeStep` through `usePersisted`, so it is the app with storage that
       * something visible reads back. Clearing has to reset the live store too: it is read once
       * at construction, in module scope, on a page CEF never unloads — so a sweep alone left
       * the old value on screen and the next write put the key straight back.
       */
      await page.locator('button', { hasText: 'Sound' }).first().click();
      // Choices are 1/2/5/10/20 and the shipped default is 5, so 20 is unambiguously a change.
      await page.getByRole('button', { name: '20%', exact: true }).click();
      await expect(page.getByRole('button', { name: '20%', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await page.keyboard.press('Backspace');

      await openApps(page);
      await page.locator('button', { hasText: 'Settings' }).first().click();
      await expect(page.locator('text=Storage used')).toBeVisible();

      await page.getByRole('button', { name: 'Clear storage' }).click();
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(page.locator('text=Storage cleared')).toBeVisible();

      // Nothing left to clear, so the button says so rather than offering again.
      await expect(page.locator('text=this app has stored nothing yet')).toBeVisible();

      // And the setting is back to its shipped default, not merely absent from storage.
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await page.locator('button', { hasText: 'Sound' }).first().click();
      await expect(page.getByRole('button', { name: '5%', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    test('uninstalls an add-on through the registry’s own path', async ({ page }) => {
      // Install Blabber first — an add-on starts absent from the launcher, so it is also absent
      // from this list until the Store puts it there.
      await page.keyboard.press('Backspace');
      await page.locator('button', { hasText: 'Store' }).first().click();
      await page
        .locator('div.rounded-xl', { hasText: 'Blabber' })
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await page.locator("button[aria-label='Back to Home']").click();

      await page.locator('button', { hasText: 'Settings' }).first().click();
      await openApps(page);
      await expect(page.locator('text=Add-ons').first()).toBeVisible();
      // Role-based, not a text match: the backgrounded Store is still in the DOM with a Blabber
      // row of its own, and `inert` keeps it out of the accessibility tree but not out of the
      // document.
      await page.getByRole('button', { name: /Blabber/ }).click();

      await expect(page.locator('text=Store add-on')).toBeVisible();
      await page.getByRole('button', { name: 'Uninstall' }).click();
      await page
        .locator('div.z-50', { hasText: 'Uninstall Blabber?' })
        .getByRole('button', { name: 'Uninstall', exact: true })
        .click();

      // Back to the list, with the app gone from it and from the launcher.
      await expect(page.locator('h1', { hasText: 'Apps' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Blabber/ })).toHaveCount(0);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await expect(page.getByRole('button', { name: /Blabber/ })).toHaveCount(0);
    });
  });
});
