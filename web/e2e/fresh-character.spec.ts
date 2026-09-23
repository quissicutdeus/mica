// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from './support/test';
import { seedHomeGrid } from './support/homeGrid';

/**
 * MICA-266: a fresh server's first character creation got stuck on a black loading
 * screen. The F8 console showed `fetchNui('svc') returned an error; using the default.
 * Player not authenticated` (expected — `bootstrapStores` preloads before the framework
 * has loaded a character) and `https://svelte.dev/e/derived_inert`, which is not.
 *
 * `?mica_boot=unauthenticated` (`web/src/nui/mocks/registry.ts`) makes every `svc` call
 * answer the same refusal `ServiceEndpoint` sends before a character exists, and clears
 * once the real `rehydrateShell` NUI message arrives — the same message
 * `server/lib/shell.ts`'s `pushRehydrate` sends once the framework actually has a
 * character, which `nuiMessages.ts` answers with `resetBootstrapState()` +
 * `bootstrapStores(true)`.
 */
test.describe('fresh character boot', () => {
  // The forced-unauthenticated boot is deliberately provoking the exact NUI failure a
  // real fresh server produces; the global fixture's job is to catch an *accidental* one.
  test.use({ allowNuiFailures: true });

  test('rehydrating across app switches and phone close does not warn derived_inert', async ({
    page
  }) => {
    const derivedInertMessages: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('derived_inert')) {
        derivedInertMessages.push(message.text());
      }
    });

    await seedHomeGrid(page, ['calculator', 'messages']);
    await page.goto('/?mica_boot=unauthenticated');
    await expect(page.getByTestId('phone-frame')).toBeVisible();

    // The unauthenticated window: open the drawer (reads capabilities/ownerConfig/admin
    // through $derived in AppDrawer), close it, open an app.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeVisible();
    // The handle, not Escape: the search input grabs focus on open, and `back` does not
    // fire while a text field has focus (AGENTS.md §2.7) — see `home-search.spec.ts`.
    await page.getByTestId('drawer-top-handle').click();
    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeHidden();

    await page.getByLabel('Home Screen').getByRole('button', { name: 'Calculator' }).click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    // The character loads: the real rehydrate arrives while an app is foreground and
    // `bootstrapStores(true)` is refilling every store the drawer and launcher read.
    await page.evaluate(() => window.postMessage({ action: 'rehydrateShell' }, '*'));

    // Switch straight back home and reopen the drawer while that refill may still be
    // in flight, rather than waiting it out.
    await page.keyboard.press('Backspace');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeVisible();
    await page.getByTestId('drawer-top-handle').click();
    await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeHidden();

    await page.getByLabel('Home Screen').getByRole('button', { name: 'Messages' }).click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();

    // Close the phone entirely — `Shell.svelte`'s `{#if visible}` tears down every
    // resident app, Home, Dock, the drawer and the toast host in one go — then reopen it,
    // the same round trip a player's own escape key drives.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('phone-frame')).toBeHidden();
    await page.keyboard.press('m');
    await expect(page.getByTestId('phone-frame')).toBeVisible();

    // Flush any pending microtasks/timers the teardown above left in flight.
    await page.waitForTimeout(500);

    expect(derivedInertMessages, derivedInertMessages.join('\n')).toEqual([]);
  });

  /**
   * MICA-266's fifth item: does every store `bootstrapStores` fills actually leave its
   * unauthenticated fallback once a character has loaded, or does one stay stuck on the
   * default forever?
   *
   * `capabilities` (`services/capabilities.ts`) is the one store on this list with a
   * directly observable effect: `refreshCapabilities()` rides the same `svc` door as
   * `refreshAdmin`/`refreshOwnerConfig`/`loadUnreadCounts`, so it is refused the same way,
   * and unlike those three its answer gates whether an app's icon renders at all
   * (`lib/phone/appVisibility.ts`'s `capabilitiesSatisfy`). Bank declares `requires:
   * ['money']` and the mock's `shell:capabilities` answers `{ money: true, jobs: true }`,
   * so "hidden while unauthenticated, visible after rehydrate" is a plain DOM assertion
   * rather than a reach into store internals no test here has a seam for.
   *
   * `getCitizenId`/`getBankBalance` are deliberately not asserted here even though
   * `services/account.ts` reads them at boot: `client/client.ts` answers both with a
   * `RegisterNuiCallbackType` handler reading `FrameworkBridge` locally, never routed
   * through `ServiceEndpoint`, so they never see this refusal in game and proving they
   * "recover" from it would be proving nothing real.
   */
  test('capabilities recovers from the unauthenticated fallback once rehydrated', async ({
    page
  }) => {
    await seedHomeGrid(page, ['bank']);
    await page.goto('/?mica_boot=unauthenticated');
    await expect(page.getByTestId('phone-frame')).toBeVisible();

    // `capabilities` starts `uniform(false)` in the mock too (`inPlainBrowser()` seeds it
    // true, but `Shell.svelte`'s mount-time `refreshCapabilities()` overwrites that with
    // the server's answer before this assertion runs) — Bank is absent.
    await expect(page.getByRole('button', { name: /Bank/ })).toHaveCount(0);

    await page.evaluate(() => window.postMessage({ action: 'rehydrateShell' }, '*'));

    await expect(page.getByRole('button', { name: /Bank/ })).toBeVisible();
  });
});
