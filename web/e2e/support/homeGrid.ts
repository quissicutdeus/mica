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
  await expect(page.getByRole('dialog', { name: 'App Drawer' })).toBeVisible();
}

/**
 * Long-presses an icon and drags it to a viewport point, mirroring `attachLongPressDrag`'s
 * own state machine: it arms after 500ms of the pointer sitting still, then tracks the
 * pointer in raw viewport coordinates until release. The wait below clears that hold
 * before any movement happens, so the gesture reads as a long-press-then-drag rather than
 * a swipe that cancels it.
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
  await page.waitForTimeout(600);
  await page.mouse.move(destX, destY, { steps: 10 });
  await page.mouse.up();
  // If the drag started inside the App Drawer, `onLongPress` already closed it — but its
  // `fly` transition takes a moment, and while it's mid-flight the drawer's own DOM is
  // still there to (very briefly) intercept a click meant for whatever the drop just
  // revealed underneath. Waiting for it to actually detach, not just report invisible,
  // is what makes the very next interaction reliable rather than occasionally flaky.
  await page.getByRole('dialog', { name: 'App Drawer' }).waitFor({ state: 'detached' });
}

/** The viewport center of a home-grid cell at `position`, for `dragIconTo`'s destination. */
export async function gridCellCenter(page: Page, position: number) {
  const cell = page.locator(`[data-position="${position}"]`);
  const box = await cell.boundingBox();
  if (!box) throw new Error(`grid cell ${position} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
