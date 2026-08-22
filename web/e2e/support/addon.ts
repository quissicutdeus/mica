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
