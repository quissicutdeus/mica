import { expect, type Page, type Locator } from '@playwright/test';

/** Mirrors `web/src/shell/state/display.ts`'s `PHONE_WIDTH` — see `notifications.spec.ts`. */
const PHONE_WIDTH = 400;

/** The frame's rendered rectangle, after the entrance fly-in has landed. */
const frameBox = async (page: Page) => {
  const frame = page.getByTestId('phone-frame');
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  const box = await frame.boundingBox();
  if (!box) throw new Error('the phone frame is not on screen');
  return box;
};

/** On-screen px per design px, at the phone's current zoom. */
const currentScale = async (page: Page) => (await frameBox(page)).width / PHONE_WIDTH;

/**
 * Places apps on the home grid before the phone boots, the same way `playwright.config.ts`'s
 * `chromium-light` project seeds the theme key in `localStorage`. `homeGridItems` is
 * `usePersisted` at module scope, read once at construction, so the value has to already be
 * there before the bundle evaluates — a post-navigation write would be too late.
 *
 * The real home grid starts empty (MICA-5), and `pnpm dev` no longer seeds it for you
 * either (see `devHarness.ts`), so this is what any spec that just needs a known app
 * reachable from the home screen — not exercising placement itself — should reach for
 * instead of driving the drag gesture. `home-grid.spec.ts` is the one place that drives the
 * gesture for real, via `openAppDrawer`/`dragIconTo` below.
 */
export async function seedHomeGrid(page: Page, appIds: string[]): Promise<void> {
  await page.addInitScript((ids: string[]) => {
    const items = ids.map((appId, position) => ({ position, kind: 'app', appId }));
    window.localStorage.setItem('gphone:settings:homeGridItems', JSON.stringify(items));
  }, appIds);
}

/**
 * Swipes the dock upward to open the App Drawer — `Dock.svelte`'s own gesture, the only
 * way in for an app that isn't already on the dock or the home grid. The drag distance
 * has to clear `shouldCommitDrag`'s 50%-of-travel threshold against
 * `SHADE_DRAG_REVEAL_DISTANCE` (850 design px); at the phone's rendered scale that is
 * comfortably covered by a full-height sweep off the dock's own box.
 */
export async function openAppDrawer(page: Page): Promise<void> {
  // Settle the frame's entrance fly-in first — `boundingBox()` waits for visibility, not
  // for the transform to finish, and a drag started mid-flight reads a stale position
  // (see `display.spec.ts`'s `frameBox`, which this mirrors).
  const scale = await currentScale(page);
  const dock = page.getByRole('toolbar', { name: 'Dock' });
  const box = await dock.boundingBox();
  if (!box) throw new Error('the dock is not on screen');
  const x = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY - scale * 700, { steps: 12 });
  await page.mouse.up();
  const drawer = page.getByRole('dialog', { name: 'App Drawer' });
  await expect(drawer).toBeVisible();
  // Same class of problem `frameBox` guards against, but for the drawer's own entrance —
  // `toBeVisible` resolves once the dialog is in the DOM and rendered, not once its `fly`
  // transition (translateY, 300ms) has finished. A caller that immediately measures an
  // icon's `boundingBox()` inside it can read a coordinate the icon is still animating
  // through; under real CPU contention that gap widens enough that the icon grid ends up
  // somewhere else by the time the recorded coordinate is actually used, and the drag picks
  // up whatever icon happens to be there instead (MICA-34).
  await expect
    .poll(async () => drawer.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
}

/**
 * Long-presses an icon and drags it to a viewport point, mirroring `attachLongPressDrag`'s
 * own state machine: it arms after 500ms of the pointer sitting still, then tracks the
 * pointer in raw viewport coordinates until release. Before arming, any pointer movement
 * past `moveTolerance` cancels the whole gesture — so this waits for `DragGhost.svelte`'s
 * `[data-testid="drag-ghost"]` (rendered only once `onLongPress` has actually fired) rather
 * than sleeping a fixed duration. A fixed `waitForTimeout` raced the app's real 500ms timer:
 * under CPU contention from a full parallel `pnpm test:e2e` run, the timer's callback could
 * still be pending when the timeout elapsed, so the subsequent `mouse.move` read as
 * pointer movement before the long-press armed and canceled the drag outright — passing
 * alone or in CI (single worker) but failing under local full-suite load (MICA-34).
 */
export async function dragIconTo(
  page: Page,
  icon: Locator,
  destX: number,
  destY: number
): Promise<void> {
  const box = await icon.boundingBox();
  if (!box) throw new Error('drag source icon is not on screen');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.getByTestId('drag-ghost').waitFor({ state: 'visible' });
  // `onLongPress` already closed the App Drawer, but its `fly` transition takes a moment,
  // and while it's mid-flight the drawer's own DOM is still there to intercept the point
  // the drop is about to land on — not just the very next interaction, but this drop
  // itself, since `elementsFromPoint` (`resolveDropAtPoint` in `iconDrag.ts`) reads
  // whatever's actually on top at that coordinate on mouseup. Waiting for the dialog to
  // actually detach, not just report invisible, is what makes the drop land on the grid
  // cell underneath instead of silently resolving against the closing drawer.
  await page.getByRole('dialog', { name: 'App Drawer' }).waitFor({ state: 'detached' });
  await page.mouse.move(destX, destY, { steps: 10 });
  await page.mouse.up();
}

/** The viewport center of a home-grid cell at `position`, for `dragIconTo`'s destination. */
export async function gridCellCenter(page: Page, position: number) {
  const cell = page.locator(`[data-position="${position}"]`);
  const box = await cell.boundingBox();
  if (!box) throw new Error(`grid cell ${position} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
