import type { FrameLocator, Locator, Page } from '@playwright/test';

/**
 * Streamer mode (MICA-249), as the specs drive it: how it is switched on before boot and how
 * a thumb announces its state. `streamer-mode.spec.ts` proves the mode reaches each surface;
 * `a11y.spec.ts` scans those surfaces with it on (MICA-405). One copy, so the two cannot
 * disagree about the key or about what "blurred" looks like in the DOM.
 */

export const STREAMER_KEY = 'mica:settings:streamerMode';

/** The flag as the settings service would hand it back for this character. */
export const seedStreamerMode = (page: Page) =>
  page.addInitScript((key: string) => {
    // Shell document only: an add-on frame has an opaque origin where this throws (MICA-206).
    if (window !== window.top) return;
    window.localStorage.setItem(key, 'true');
  }, STREAMER_KEY);

/**
 * The state `MediaThumb` announces, never a computed `filter`: Playwright's Chromium is not
 * CEF, and a blur it can measure says nothing about the one in game. The attribute is what
 * the mode decided; the pixels are `blur-media`'s and CEF's.
 */
export const blurred = (scope: Page | FrameLocator | Locator) =>
  scope.locator('[data-streamer="blurred"]');
export const revealed = (scope: Page | FrameLocator | Locator) =>
  scope.locator('[data-streamer="revealed"]');
/**
 * The "Tap to reveal" `<button>` of a thumb with no control around it (a Blab's picture, the
 * full view). A thumb *inside* a control draws no button at all (MICA-405): the control is
 * the gate, so activate the tile itself, and it is described as "Tap to reveal" instead.
 */
export const revealButton = (scope: Page | FrameLocator | Locator) =>
  scope.getByRole('button', { name: 'Tap to reveal' });
