import type { Page, FrameLocator } from '@playwright/test';

/** The document an add-on renders in. Page-level locators do not see into it. */
export const addOnFrame = (page: Page, id: string): FrameLocator =>
  page.frameLocator(`iframe[data-app="${id}"]`);

/**
 * Clear the shell's toast layer before driving an add-on inside its iframe.
 *
 * Playwright's actionability hit-test for a `FrameLocator` runs `elementFromPoint` in the
 * *frame's own* document, so it cannot see anything the parent document paints over the
 * frame. `ToastHost` puts its stack at `absolute top-12 ... z-50` with
 * `pointer-events-auto` cards — directly over the top strip of whatever app is on screen —
 * and the Store's "<app> installed successfully!" toast lives there for 4.5s after the
 * install these specs do in `beforeEach`. The hit-test passes (inside the frame the button
 * really is on top), the synthesized click lands on the toast in the parent document, and
 * the app never sees it: no error, no timeout, just a click that did nothing. That is what
 * made every in-frame click against Blabber's header — the identity avatar, the Messages
 * icon — silently miss.
 *
 * For an in-process app the identical overlay is caught by the same check and Playwright
 * simply waits it out, so this is not a workaround for a product bug; it restores, for the
 * cross-document case, the occlusion check Playwright cannot perform there. It dismisses
 * rather than waits out the 4.5s so the suite does not pay that per test, and it uses the
 * toast's own "Dismiss notification" button rather than `force`/`dispatchEvent` — that
 * button is in the parent document, where Playwright's checks work normally.
 */
export const dismissToasts = async (page: Page): Promise<void> => {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  // Bounded: one pass per toast currently on screen, and a toast that expires on its own
  // between the count and the click simply leaves nothing to do.
  for (let left = await dismiss.count(); left > 0; left -= 1) {
    const first = dismiss.first();
    if ((await first.count()) === 0) break;
    await first.click();
  }
};

/**
 * Install a bundled add-on through the Store, the way a player reaches one.
 *
 * `core: false` apps are absent from the launcher until they are installed (AGENTS.md §11),
 * so every add-on spec needs this before it can open anything — and three of them had
 * grown their own copy of it. Extracted rather than copied again for MICA-59, since the
 * copies had already drifted apart in the one way that matters: the row is matched on the
 * card, not on `text=`, because a bare text match also hits the description, and the button
 * is matched by exact role name, because "Uninstall" *contains* "Install".
 *
 * Leaves the phone on the home screen with the app's icon on it, which is where an
 * `openInstalledApp` or a plain `getByRole` click carries on from.
 */
export const installAddOn = async (page: Page, name: string): Promise<void> => {
  await page.locator('button', { hasText: 'Store' }).first().click();
  await page
    .locator('div.rounded-xl', { hasText: name })
    .getByRole('button', { name: 'Install', exact: true })
    .click();
  await page.locator("button[aria-label='Return to home screen']").click();
};

/**
 * Open an app from the home screen by its display name, then clear the toast layer.
 *
 * Role-based rather than `locator('button', { hasText })`: apps stay resident once opened,
 * so the Store's own catalog row is still in the DOM behind the home screen and only
 * `inert` keeps it out of the accessibility tree. The `dismissToasts` is what makes a
 * subsequent in-frame click land — see the note on that function.
 */
export const openInstalledApp = async (page: Page, name: string): Promise<void> => {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await dismissToasts(page);
};
