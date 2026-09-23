import { test, expect } from './support/test';
import { settlePhoneOpen } from './support/phoneOpen';

/**
 * MICA-287 round 5: split out of `defects.spec.ts`, deliberately. That file's own
 * `beforeEach` seeds a home grid (`seedHomeGrid`) for its other tests, and `page.
 * addInitScript` re-runs on every navigation in the page — including this test's own
 * `page.goto('/')` below, not just the `beforeEach`'s. Once `settings:getAll`'s mock
 * started answering from real `localStorage` (round 4), that seeded `homeGridItems` row
 * made `onboarding.ts`'s `migrateAppDrawerHintForExistingSaves` see a genuinely existing
 * save and hide the hint before this test ever got to look for it — correctly, for a
 * character who really does have a customized home screen, which is exactly why the fix
 * belongs here rather than in that check. A file with no other test and no shared
 * `beforeEach` is what keeps this one honestly fresh.
 */
test.describe('The first-run hint does not overlap the Dock', () => {
  // A fresh install ships with pinned Dock apps out of the box (`DEFAULT_DOCK_APP_IDS` in
  // `state/dock.ts`) and shows the "Swipe up for apps" hint until the drawer is opened
  // once. `Dock.svelte` positioned the hint at `bottom-32` and the Dock itself at
  // `bottom-10` with `py-4` padding, and the Dock's icon-and-label content was taller
  // than the gap between those two anchors — so the hint was drawn directly over the
  // pinned icons themselves on every fresh install, not just over blank padding above
  // them. Checked against an actual icon's box, not the Dock toolbar's own bounding box
  // (which includes its top padding) — overlapping that padding is harmless, since
  // nothing is drawn there and the hint is `pointer-events-none`.
  test('the hint sits above the Dock icons, not over them', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();

    // Both boxes below are read while the phone is on screen, and the phone flies in over
    // 500ms — without this the two reads sample the element at two different points in
    // that flight and the comparison is meaningless. See `support/phoneOpen.ts`.
    await settlePhoneOpen(page);

    const hint = page.getByText('Swipe up for apps');
    await expect(hint).toBeVisible();
    const hintBox = await hint.boundingBox();
    const iconBox = await page
      .getByRole('toolbar', { name: 'Dock' })
      .getByRole('button')
      .first()
      .boundingBox();
    if (!hintBox || !iconBox) throw new Error('hint or dock icon not on screen');

    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(iconBox.y);
  });
});
