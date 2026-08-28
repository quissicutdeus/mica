// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import PhoneFrame from './PhoneFrame.svelte';
import { charge } from './state/charge';

/**
 * In game the phone is a transparent NUI overlay: the camera viewfinder is the actual
 * world showing through it. Any opaque background **anywhere in the ancestor chain**
 * turns that into a black rectangle.
 *
 * That is exactly how it shipped. `transparent` was applied to the inner screen div
 * while the outer frame kept an unconditional `bg-gray-950`, so the screen was
 * see-through onto a near-black parent and the viewfinder was black no matter what.
 * The bug is invisible in a browser, where the camera module paints its own mock
 * backdrop.
 *
 * These assertions are about the whole chain, not one element, because a single
 * element being right is what made the original bug so easy to miss.
 */

/**
 * Tailwind background utilities that would occlude the game world.
 *
 * `surface*` is in the list because of how nearly this test stopped working. The
 * original pattern named only raw palette families, so when the phone moved to M3
 * color roles a `bg-surface` on the screen — the obvious thing to reach for, and an
 * opaque color — matched nothing here. The suite would have stayed green while the
 * viewfinder went black in game, which is the precise failure this file exists to
 * catch. A role token is opaque like any other fill; the naming scheme changed, the
 * hazard did not.
 */
const OPAQUE_BG = /(^|\s)bg-(gray|black|white|slate|zinc|neutral|stone|surface)[\w-]*(\s|$)/;

// jsdom has no Web Animations API and Svelte's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const noopSnippet = (() => {}) as never;

const renderFrame = (transparent: boolean) =>
  render(PhoneFrame, {
    props: { transparent, onClose: () => {}, children: noopSnippet }
  });

describe('PhoneFrame transparency', () => {
  beforeEach(() => {
    // A dead phone deliberately paints black; keep it alive for these cases.
    charge.set(100);
  });

  it('leaves no opaque background in the chain when transparent', () => {
    const { getByTestId } = renderFrame(true);

    for (const id of ['phone-frame', 'phone-screen']) {
      const el = getByTestId(id);
      expect(el.className, `${id} would occlude the game world`).not.toMatch(OPAQUE_BG);
    }
  });

  it('keeps the bezel border even when transparent', () => {
    // The border is the phone body, not the display — dropping it with the fill would
    // leave the UI floating with no visible edge.
    const { getByTestId } = renderFrame(true);
    expect(getByTestId('phone-frame').className).toMatch(/border-gray-950/);
  });

  it('is opaque as normal when not transparent', () => {
    const { getByTestId } = renderFrame(false);
    expect(getByTestId('phone-frame').className).toMatch(/bg-gray-950/);

    // The screen's fill is the wallpaper, and it is always one inline `background` — a
    // generated gradient for a color, a `url()` for a photo. It used to be a Tailwind
    // class for a preset and a style for everything else, and the assertion here matched
    // `bg-gray-900|gradient`, passing on the `gradient` half purely by coincidence: the
    // `bg-gray-900` branch beside it could never apply, and the default wallpaper simply
    // happened to be a gradient.
    const style = getByTestId('phone-screen').getAttribute('style') ?? '';
    expect(style, 'phone-screen has no wallpaper fill').toContain('background:');
  });

  it('keeps a digit-free accessible name on the status bar', () => {
    // Load-bearing for the e2e suite, which is not obvious from here.
    //
    // The status bar is a `<button>` displaying the clock and the battery percentage,
    // and it precedes every app in the DOM. Several e2e specs click keypad digits, and
    // when they addressed them by *text* the status bar won — so `phone.spec.ts` failed
    // for any time containing a 5 or a 9, and `keybinds.spec.ts` for a 7 or an 8. Those
    // specs now use `getByRole(name:)`, which reads the accessible name, and this label
    // is the only reason that distinguishes the two.
    //
    // Delete or templatise this label and the flake comes back, in specs that do not
    // mention this file. Hence the assertion here rather than a comment there.
    const bar = renderFrame(false).getByRole('button', { name: /notification shade/i });
    const label = bar.getAttribute('aria-label') ?? '';
    expect(label).not.toMatch(/\d/);
    expect(bar.textContent ?? '').toMatch(/\d/); // the digits are still on screen
  });

  it('writes the theme onto the screen', () => {
    // The screen is the theme root: these custom properties inherit from here into every
    // app, so an app writing `bg-surface-container` resolves against whatever the player
    // seeded. Nothing else in the suite would notice if they stopped being emitted —
    // every utility would silently fall back to the shipped literal in `app.css`.
    const style = renderFrame(false).getByTestId('phone-screen').getAttribute('style') ?? '';
    expect(style).toContain('--color-surface:');
    expect(style).toContain('--color-on-surface:');
  });

  it('writes the theme but not the wallpaper when transparent', () => {
    // The wallpaper is withheld so the game world shows through, but the UI drawn over
    // it still has to be themed. These two travel on the same attribute, so it is worth
    // asserting that suppressing one does not take the other with it.
    const style = renderFrame(true).getByTestId('phone-screen').getAttribute('style') ?? '';
    expect(style).toContain('--color-surface:');
    expect(style).not.toContain('background:');
  });

  it('stays opaque when the battery is dead, even if transparent was asked for', () => {
    // The dead screen is a black slab by design; letting the world through it would
    // read as the phone still being on.
    charge.set(0);
    const { getByTestId } = renderFrame(true);
    expect(getByTestId('phone-frame').className).toMatch(/bg-gray-950/);
    expect(getByTestId('phone-screen').className).toMatch(/bg-black/);
  });

  it('closes notification shade when open on clicking home gesture bar', async () => {
    const { getByRole, findByRole } = renderFrame(false);
    const { openShade, isShadeOpen } = await import('./state/shade');
    const { get } = await import('svelte/store');
    const { fireEvent } = await import('@testing-library/svelte');

    openShade();
    expect(get(isShadeOpen)).toBe(true);

    // The label names the action the press will perform, so with the shade open the bar
    // announces itself as "Collapse notifications" rather than as home. Looking it up by
    // that name is also what asserts the label actually tracks the state — a static
    // label would fail here rather than quietly describing the wrong thing.
    // `findByRole`, not `getByRole`: `openShade()` is a direct store write from outside
    // the component, so Svelte has not flushed the re-render yet and the synchronous
    // query would read the pre-open label.
    const homeBar = await findByRole('button', { name: /Collapse notifications/i });
    await fireEvent.click(homeBar);

    expect(get(isShadeOpen)).toBe(false);
    expect(getByRole('button', { name: /Return to home screen/i })).toBeTruthy();
  });

  it('keeps the home bar pressable and visible above the notification shade', async () => {
    // MICA-38: the home bar used to sit at the same layer as the shade, so opening the
    // shade painted over it — still labelled "Collapse notifications", entirely
    // unclickable. Comparing the two z-index utilities (rather than asserting a literal
    // `z-60`) catches a regression that drops the bar back level with or below the sheet,
    // whatever number either one is renamed to.
    const { getByRole, findByRole } = renderFrame(false);
    const { openShade, isShadeOpen } = await import('./state/shade');
    const { get } = await import('svelte/store');

    openShade();
    expect(get(isShadeOpen)).toBe(true);

    const homeBar = await findByRole('button', { name: /Collapse notifications/i });
    const shade = getByRole('dialog');

    const zIndexOf = (el: HTMLElement) => {
      const match = el.className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
      if (!match) throw new Error(`no z-index utility class on: ${el.className}`);
      return Number(match[1]);
    };

    expect(
      zIndexOf(homeBar),
      'home bar must stack above the shade to stay pressable'
    ).toBeGreaterThan(zIndexOf(shade));

    // Pressable isn't enough on its own — the pill also switches off `bg-white` while a
    // sheet is open, because white is invisible on the sheet's near-white
    // `surface-container-high` fill in the light color scheme. A reachable-but-invisible
    // control is the same silent failure with a different symptom.
    const pill = homeBar.querySelector('div');
    expect(pill?.className ?? '').not.toMatch(/bg-white/);
  });

  it('opens the app drawer on a swipe-up starting on the home bar (MICA-45)', async () => {
    // The swipe-up-to-open-the-drawer gesture used to be wired only to `Dock.svelte`.
    // The home bar sits underneath it as a sibling element, not a descendant, so a
    // pointerdown that landed there never reached the Dock's listener and the swipe
    // silently did nothing.
    const { isDrawerOpen } = await import('./state/appDrawer');
    const { isShadeOpen } = await import('./state/shade');
    const { SHADE_DRAG_REVEAL_DISTANCE } = await import('./state/display');
    const { get } = await import('svelte/store');

    isDrawerOpen.set(false);
    isShadeOpen.set(false);

    const { getByRole } = renderFrame(false);
    const homeBar = getByRole('button', { name: /Return to home screen/i });

    const fire = (type: string, target: EventTarget, clientY: number, timeMs: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY,
        pointerId: 1,
        button: 0
      });
      Object.defineProperty(event, 'timeStamp', { value: timeMs, configurable: true });
      target.dispatchEvent(event);
    };

    const commitDeltaY = -(SHADE_DRAG_REVEAL_DISTANCE * 0.6);
    fire('pointerdown', homeBar, 0, 0);
    fire('pointermove', window, commitDeltaY, 20);
    fire('pointerup', window, commitDeltaY, 20);

    expect(get(isDrawerOpen)).toBe(true);

    // A real browser fires a synthetic `click` right after a touch/pointer release, which
    // is what `attachDragGesture`'s `suppressClickAfterDrag` is there to swallow (so the
    // drag-release doesn't also trigger the button's own tap handler). jsdom never
    // synthesizes that click on its own, so without firing one here that swallow-once
    // `window` listener leaks past this test and silently eats the first real click of
    // whichever test runs next in this file.
    homeBar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  it('closes the app drawer when tapping the home bar (MICA-45)', async () => {
    // The home bar's tap handler used to only check the shade — pressing it while the
    // drawer (which used to be a separate search sheet too) was open fell through to the
    // no-op `goHome()` branch.
    const { isDrawerOpen, openDrawer } = await import('./state/appDrawer');
    const { isShadeOpen } = await import('./state/shade');
    const { get } = await import('svelte/store');
    const { fireEvent } = await import('@testing-library/svelte');

    isDrawerOpen.set(false);
    isShadeOpen.set(false);

    const { getByRole, findByRole } = renderFrame(false);

    openDrawer();
    expect(get(isDrawerOpen)).toBe(true);

    const homeBar = await findByRole('button', { name: /Close app drawer/i });
    await fireEvent.click(homeBar);

    expect(get(isDrawerOpen)).toBe(false);
    expect(getByRole('button', { name: /Return to home screen/i })).toBeTruthy();
  });
});

/**
 * MICA-103: the tray of per-app notification icons runs left-to-right into the
 * hole-punch camera, which is a fixed point on a fixed-width frame. It used to be capped
 * at five, a number picked without counting the `gap-1` between the icons, so the fifth
 * icon ended exactly where the cutout begins and was drawn half underneath it.
 *
 * The arithmetic behind the cap is in `state/display.ts`. What is asserted here is the
 * behaviour it exists for: the tray never draws more than the cap, and the remainder is
 * still reported rather than silently dropped.
 */
describe('status bar notification icons', () => {
  beforeEach(async () => {
    charge.set(100);
    const { unreadCounts } = await import('../services/notifications');
    const { resetMusicForTest } = await import('./state/music');
    unreadCounts.set({});
    // Music occupies one of these slots when it is loaded (MICA-111), so a track left
    // playing by an earlier suite would silently change every count below.
    resetMusicForTest();
  });

  /** Real registry ids, so the manifest lookup in `PhoneFrame` actually resolves. */
  const appIds = async (count: number) => {
    const { appRegistryStore } = await import('./state/registry');
    const { get } = await import('svelte/store');
    const ids = get(appRegistryStore)
      .filter((app) => Boolean(app.icon))
      .map((app) => app.id)
      .slice(0, count);
    expect(ids, 'registry has too few apps to exercise the cap').toHaveLength(count);
    return ids;
  };

  const setUnread = async (ids: string[]) => {
    const { unreadCounts } = await import('../services/notifications');
    unreadCounts.set(Object.fromEntries(ids.map((id) => [id, 1])));
  };

  it('caps the icons and counts the rest into an overflow chip', async () => {
    const { STATUS_BAR_MAX_NOTIFICATION_ICONS } = await import('./state/display');
    const overflow = 3;
    await setUnread(await appIds(STATUS_BAR_MAX_NOTIFICATION_ICONS + overflow));

    const { findByTestId } = renderFrame(false);
    const tray = await findByTestId('status-notification-icons');

    // Direct children, not a `querySelectorAll('svg')`: an app icon is free to nest as
    // many elements as it likes, and what is being bounded here is how many slots the row
    // occupies, one per child.
    expect(tray.children).toHaveLength(STATUS_BAR_MAX_NOTIFICATION_ICONS + 1);
    expect(tray.textContent?.trim()).toBe(`+${overflow}`);
  });

  it('draws no chip when everything fits', async () => {
    const { STATUS_BAR_MAX_NOTIFICATION_ICONS } = await import('./state/display');
    await setUnread(await appIds(STATUS_BAR_MAX_NOTIFICATION_ICONS));

    const { findByTestId } = renderFrame(false);
    const tray = await findByTestId('status-notification-icons');

    expect(tray.children).toHaveLength(STATUS_BAR_MAX_NOTIFICATION_ICONS);
    expect(tray.textContent?.trim()).toBe('');
  });

  it('leaves room for the chip beside the cutout', async () => {
    // The cap is a pixel budget, so assert it as one rather than as a magic number: the
    // widest the row can get must still land left of the cutout's own edge. Kept in the
    // same units the classes are written in — see `state/display.ts` for the derivation.
    //
    // The music indicator is inside this budget rather than beside it (MICA-111): it
    // takes one of the cap's slots and is drawn at the same `h-3.5 w-3.5` as an app icon,
    // so the worst case is still `cap` glyphs and a chip whether or not a track is loaded,
    // and this arithmetic is unchanged by the move. `takes a capped slot rather than
    // adding a fourth glyph` below is what holds the component to that.
    const { STATUS_BAR_MAX_NOTIFICATION_ICONS, PHONE_WIDTH } = await import('./state/display');

    const BAR_PADDING_LEFT = 32; // px-8
    const CLOCK_WIDTH = 62; // "12:34 AM" at text-body-medium
    const GAP = 4; // gap-1, between icons and before the chip
    const CLOCK_GAP = 8; // gap-2, after the clock
    const ICON = 14; // h-3.5 w-3.5 — the music glyph too, at the tray's size and not its own
    const CHIP_WIDTH = 24; // "+10" at text-label-small, the widest realistic chip
    const CUTOUT = 24; // size-icon-lg

    const icons =
      STATUS_BAR_MAX_NOTIFICATION_ICONS * ICON + (STATUS_BAR_MAX_NOTIFICATION_ICONS - 1) * GAP;
    const rowEnd = BAR_PADDING_LEFT + CLOCK_WIDTH + CLOCK_GAP + icons + GAP + CHIP_WIDTH;
    const cutoutStart = PHONE_WIDTH / 2 - CUTOUT / 2;

    expect(rowEnd).toBeLessThan(cutoutStart);
  });
});

/**
 * The music indicator (MICA-111).
 *
 * It lives in the left-hand notification tray, because the now-playing card in the shade
 * is presented as a persistent notification — non-dismissible, untouched by Clear All —
 * and an icon for a notification belongs where notification icons are. It used to sit on
 * the right among bluetooth, signal and battery, where it read as a hardware state.
 *
 * What makes that move safe is that it **occupies one of the capped slots** rather than
 * adding a fourth glyph. The left run has under four pixels of headroom before the camera
 * cutout (`STATUS_BAR_MAX_NOTIFICATION_ICONS` in `state/display.ts` shows the working), so
 * the pixel budget only holds if the drawn count is unchanged. The cases below assert both
 * halves: music displaces a notification into the `+N` chip, and music is never itself the
 * thing hidden by it.
 */
describe('PhoneFrame music indicator', () => {
  beforeEach(async () => {
    const { resetMusicForTest } = await import('./state/music');
    const { unreadCounts } = await import('../services/notifications');
    resetMusicForTest();
    unreadCounts.set({});
    charge.set(100);
  });

  it('is absent while nothing is loaded', async () => {
    const { queryByTestId } = renderFrame(false);
    expect(queryByTestId('status-music-indicator')).toBeNull();
  });

  it('appears while something is playing', async () => {
    const { playSource } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');

    const { findByTestId } = renderFrame(false);
    expect(await findByTestId('status-music-indicator')).toBeTruthy();
  });

  it('stays up while paused, quieter', async () => {
    // Paused still means the phone is holding a track, which is the thing a person who
    // put the phone down needs to be able to see. `text-on-surface-variant` is the "same
    // text, quieter" role — never an opacity modifier on a themed role (AGENTS.md §6).
    const { playSource, pauseMusic } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');
    pauseMusic();

    const { findByTestId } = renderFrame(false);
    const indicator = await findByTestId('status-music-indicator');
    expect(indicator.className).toMatch(/text-on-surface-variant/);
  });

  it('marks a refused track as an error rather than dimming it', async () => {
    // Dimmed is what paused looks like. A failure that renders as a pause leaves somebody
    // waiting for audio that is never coming, so it takes `text-error` — the same idiom
    // the charge percentage two elements along already uses at 20%.
    const { playSource, reportPlayerError } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');
    reportPlayerError(150);

    const { findByTestId } = renderFrame(false);
    const indicator = await findByTestId('status-music-indicator');
    expect(indicator.className).toMatch(/text-error/);
    expect(indicator.className).not.toMatch(/text-on-surface-variant/);
  });

  it('sits in the notification tray, at its head', async () => {
    const { playSource } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');

    const { findByTestId } = renderFrame(false);
    const tray = await findByTestId('status-notification-icons');
    const indicator = tray.querySelector('[data-testid="status-music-indicator"]');

    // In the tray, in the left group, and first — an ongoing thing has no arrival time to
    // be sorted by, so it takes the one slot that does not move as notifications come and
    // go. See `PhoneFrame.svelte` for the argument.
    expect(indicator).toBeTruthy();
    expect(tray.children[0]).toBe(indicator);

    const statusBar = indicator?.closest('button');
    const [leftGroup, rightGroup] = Array.from(statusBar?.children ?? []);
    expect(leftGroup.contains(indicator)).toBe(true);
    expect(rightGroup.contains(indicator)).toBe(false);
  });

  it('draws the tray on its own when nothing is unread', async () => {
    const { playSource } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');

    const { findByTestId } = renderFrame(false);
    const tray = await findByTestId('status-notification-icons');

    // The tray is otherwise conditional on there being something unread; music has to be
    // able to bring it up by itself, or the glyph is invisible exactly when the phone is
    // quiet and playing.
    expect(tray.children).toHaveLength(1);
    expect(tray.textContent?.trim()).toBe('');
  });

  /**
   * Render, wait for the shade's own fetch to land, and only then set the unread counts.
   *
   * Not the other way round, which is what the cap suite above does and gets away with:
   * `NotificationShade`'s `onMount` calls `loadUnreadCounts`, which overwrites the store
   * with whatever the browser mock answers, on the mock transport's own timer. Counts set
   * before the render are simply discarded by it, and a test that happens to await one
   * element fewer reads the store at a different point in that sequence. Waiting for the
   * mock's write and then making the last one is deterministic rather than lucky.
   */
  const renderWithUnread = async (count: number) => {
    const { unreadCounts } = await import('../services/notifications');
    const { appRegistryStore } = await import('./state/registry');
    const { get } = await import('svelte/store');
    const { tick } = await import('svelte');

    const view = renderFrame(false);
    const tray = await view.findByTestId('status-notification-icons');
    await vi.waitFor(() => expect(Object.keys(get(unreadCounts)).length).toBeGreaterThan(0));

    const ids = get(appRegistryStore)
      .filter((app) => Boolean(app.icon))
      .map((app) => app.id)
      .slice(0, count);
    expect(ids, 'registry has too few apps for this case').toHaveLength(count);
    unreadCounts.set(Object.fromEntries(ids.map((id) => [id, 1])));
    await tick();

    return { tray, ids };
  };

  it('takes a capped slot rather than adding a fourth glyph', async () => {
    const { STATUS_BAR_MAX_NOTIFICATION_ICONS } = await import('./state/display');
    const { playSource } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');

    const { tray } = await renderWithUnread(STATUS_BAR_MAX_NOTIFICATION_ICONS);

    // The whole safety argument for the move: the drawn count is what the pixel budget in
    // `state/display.ts` was measured against, and it is unchanged. Music plus two icons
    // and then the chip — four children, not five, exactly as without music playing.
    expect(tray.children).toHaveLength(STATUS_BAR_MAX_NOTIFICATION_ICONS + 1);
    expect(tray.textContent?.trim()).toBe('+1');
  });

  it('is never the icon the overflow chip hides', async () => {
    const { STATUS_BAR_MAX_NOTIFICATION_ICONS } = await import('./state/display');
    const { playSource } = await import('./state/music');
    playSource('https://youtu.be/dQw4w9WgXcQ');

    // Far more unread apps than slots, so the chip is doing real work. Music still draws:
    // a glyph whose job is "this is still making noise while you are elsewhere" cannot be
    // the one that gets counted instead of shown.
    const { tray, ids } = await renderWithUnread(STATUS_BAR_MAX_NOTIFICATION_ICONS + 4);
    const indicator = tray.querySelector('[data-testid="status-music-indicator"]');

    expect(tray.children[0]).toBe(indicator);
    expect(tray.children).toHaveLength(STATUS_BAR_MAX_NOTIFICATION_ICONS + 1);
    expect(tray.textContent?.trim()).toBe(
      `+${ids.length - (STATUS_BAR_MAX_NOTIFICATION_ICONS - 1)}`
    );
  });

  it('leaves the right-hand run shorter than it was', async () => {
    const { PHONE_WIDTH } = await import('./state/display');

    const BAR_PADDING_RIGHT = 32; // px-8
    const GAP = 8; // gap-2, between each glyph in the right group
    const BATTERY_ICON = 24; // h-3 w-6
    const BATTERY_GAP = 6; // gap-1.5
    const CHARGE_WIDTH = 33; // "100%" at text-body-small (12px)
    const SIGNAL = 16; // size-icon-sm
    const BLUETOOTH = 14; // h-3.5 w-3.5
    const CUTOUT = 24; // size-icon-lg

    // Everything on at once, measured leftward from the content edge. The music glyph and
    // its `gap-2` used to add 24px here; removing it is the one geometric effect of the
    // move, and it is in the direction that has slack either way.
    const width = BATTERY_ICON + BATTERY_GAP + CHARGE_WIDTH + GAP + SIGNAL + GAP + BLUETOOTH;
    const rowStart = PHONE_WIDTH - BAR_PADDING_RIGHT - width;
    const cutoutEnd = PHONE_WIDTH / 2 + CUTOUT / 2;

    expect(rowStart).toBeGreaterThan(cutoutEnd);
  });
});
