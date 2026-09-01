import { test, expect, type Page } from './support/test';

/**
 * The phone slides up when it is opened (MICA-86).
 *
 * This is the regression the suite could not see. `PhoneFrame`'s `transition:fly` is a
 * **local** transition, and a local transition does not play on initial render — so a
 * phone whose `visible` already starts `true` has its frame created silently, with no
 * fly-in, and the animation is skipped for the whole session. `Shell` used to seed
 * `visible` from `isBrowser()`, which is evaluated at module-init and so depends on CEF
 * having injected `window.invokeNative` by then; losing that race started the phone open
 * in game and cost it the slide-up.
 *
 * Asserting on the animation rather than on a transform value, because a transform is
 * only wrong for the 500ms the fly is in flight and this test would otherwise be a race
 * against it. `Element.prototype.animate` is patched *before the page loads* instead, so
 * the record survives however long the assertion takes to run — Svelte's transitions are
 * WAAPI, so every fly-in shows up here exactly once.
 *
 * `display.spec.ts` polls `getAnimations()` down to 0 to wait one of these out, which
 * read as coverage and was not: before this fix nothing ever started, so the poll was
 * satisfied by the absence of the very thing it was written to wait for.
 */
const recordAnimations = (page: Page) =>
  page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __animated: string[] }).__animated = seen;

    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: unknown[]) {
      const testid = (this as HTMLElement).dataset?.testid;
      if (testid) seen.push(testid);
      return (original as (...a: unknown[]) => Animation).apply(this, args);
    } as typeof Element.prototype.animate;
  });

const animatedElements = (page: Page) =>
  page.evaluate(() => (window as unknown as { __animated: string[] }).__animated);

test.describe('the phone slides up when it opens', () => {
  test('the frame flies in on first open rather than simply appearing', async ({ page }) => {
    await recordAnimations(page);
    await page.goto('/');

    await expect(page.getByTestId('phone-frame')).toBeVisible();

    // The assertion the ticket is about: the frame was *animated* into place, not
    // constructed already there.
    await expect.poll(() => animatedElements(page)).toContain('phone-frame');
  });

  test('and again on every reopen, which is the path the game actually takes', async ({ page }) => {
    await recordAnimations(page);
    await page.goto('/');

    // The shell's `keydown` handler attaches in `onMount`, so a key pressed before that
    // is dropped silently. `appRegistryStore` is assigned at the end of
    // `installDevHarness`, which `onMount` calls — see `keybinds.spec.ts` for the full
    // story on why this wait is not optional.
    await page.waitForFunction(() => 'appRegistryStore' in window);
    await expect(page.getByTestId('phone-frame')).toBeVisible();
    await expect.poll(() => animatedElements(page)).toContain('phone-frame');

    await page.evaluate(() => {
      (window as unknown as { __animated: string[] }).__animated.length = 0;
    });

    // Escape closes the phone outright — not "back to home" — and the collapsed-phone
    // affordance is what to assert on: `<main>` waits out the 500ms outro before it
    // leaves the DOM, while this button has no transition and flips immediately.
    await page.keyboard.press('Escape');
    const openPhone = page.getByRole('button', { name: /Open gPhone/i });
    await expect(openPhone).toBeVisible();

    await openPhone.click();

    await expect(page.getByTestId('phone-frame')).toBeVisible();
    await expect.poll(() => animatedElements(page)).toContain('phone-frame');
  });
});
