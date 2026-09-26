import { expect, type Page } from '@playwright/test';

/**
 * Wait out the phone's open animation before measuring anything on screen.
 *
 * The phone arrives on a 500ms `transition:fly` (MICA-86). `toBeVisible()` resolves the
 * moment the frame is in the DOM and painted, which is the *start* of that flight, not the
 * end — so any geometry read before this settles is a sample from a moving element, and two
 * reads taken in sequence are samples from two different positions.
 *
 * That is not hypothetical. `defects.spec.ts` compares a hint's box against a Dock icon's,
 * and it passed for a while only because nothing animated: the phone used to start open, so
 * its frame was created at initial render where a local transition does not play. Restoring
 * the fly-in made the same two reads land 36px apart and the assertion fail, on a layout
 * that had not changed at all.
 *
 * Also waits out the boot screen, below.
 *
 * Polls `getAnimations()` rather than sleeping, so it costs whatever the animation actually
 * costs and does not go stale if the duration is ever retuned.
 */
export const settlePhoneOpen = async (page: Page): Promise<void> => {
  const frame = page.getByTestId('phone-frame');
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  // The boot screen (MICA-236) plays over the first open and is opaque black: axe would
  // read the status bar against it, and a geometry read would sample a covered screen. It
  // unmounts when done (not merely transparent), so the wait is for its removal.
  await expect(page.getByTestId('boot-screen')).toHaveCount(0, { timeout: 5000 });
};
