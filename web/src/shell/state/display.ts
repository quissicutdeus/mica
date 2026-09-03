// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { captureZoomBoost } from '../../../../sdk/host/seam/captureZoom';
import { derived, get, writable } from 'svelte/store';
import { DEVICES, type DeviceFrame } from '@gphone/shared/devices';
import { frame, perDevice } from './device';
import { isTypingTarget } from './keybinds';

/**
 * How big the phone is drawn, and the one place its size is stated.
 *
 * The phone is a fixed-resolution device: every screen in `apps/` is laid out against
 * 400x850 CSS pixels and picks its type sizes, paddings and icon boxes for that. So this
 * is a **zoom**, applied as one `transform: scale()` in `Shell.svelte`, not a responsive
 * layout. Changing the frame's width and height instead would reflow thirteen apps at
 * sizes none of them was designed at — the phone would get narrower while its 14px text
 * stayed 14px, which is a different phone rather than a smaller one.
 *
 * 400x850 is 17:8 exactly, and the screen inside the 8px bezel is 384x834 — 2.172, which
 * is within a hair of the 19.5:9 (2.167) that every phone since the iPhone X has used.
 * There is no nearby number worth moving to: landing the screen exactly on 19.5:9 means
 * an outer height of 848, a two-pixel change nobody can see that trades an exact outer
 * ratio for an inexact one.
 */
//
// The numbers themselves live in `shared/devices.ts` (MICA-258): the phone is one device of
// two, and the tablet's frame has to be stated in the same place as this one, by the same
// name, for the client and server halves to read. This module stays the one place a
// device's *zoom* is decided.
//
// Since MICA-259 the shell draws whichever device `state/device.ts` names, and everything
// below that used to read these two constants reads the `frame` store instead. They stay
// exported as the phone's numbers — for the places that are about the phone specifically,
// and for the tests that pin it to the table.
export const PHONE_WIDTH = DEVICES.phone.frame.width;
export const PHONE_HEIGHT = DEVICES.phone.frame.height;

/**
 * How far, in design px, a finger has to travel to fully reveal or dismiss the
 * notification shade by drag. Shared by the status-bar open-drag and the shade's own
 * grab-handle close-drag so the two gestures feel symmetric — equal to the frame's
 * height so the panel tracks the finger 1:1 with zero offset across the full screen.
 *
 * A store rather than a constant since MICA-259: the number is the active device's
 * height, 850 on the phone and 800 on the tablet, and the sheets that map this progress
 * onto a `translateY` (`NotificationShade`, `AppDrawer`) read the same store, so the
 * sheet never outruns the finger on either.
 */
export const shadeDragRevealDistance = derived(frame, ($frame) => $frame.height);

/**
 * How many per-app notification icons the status bar will draw before collapsing the rest
 * into a `+N` chip (MICA-103).
 *
 * The number is the frame's geometry, not a taste call, so it belongs next to the frame's
 * other dimensions rather than in `PhoneFrame.svelte`. Measured left to right across the
 * 400px-wide bar, in the classes that row actually carries:
 *
 * - the bar is `px-8`, so the left group starts at **32px**
 * - the clock is `text-body-medium` (14px); "12:34 AM", its widest reading, is about
 *   **62px** — 24-hour time is narrower, so this is the case that has to fit
 * - `gap-2` (**8px**) before the icon row
 * - each icon is `h-3.5 w-3.5` (14px) with `gap-1` (4px) between, so `n` of them measure
 *   `18n - 4` — **50px** at three
 * - `gap-1` again (**4px**), then the `+N` chip at `text-label-small` (11px), about
 *   **18px** at two glyphs and 24 at three
 *
 * That lands the row's right edge at 174px with a two-glyph chip. The hole-punch camera is
 * `size-icon-lg` (24px) centred on the frame, so its left edge is at **188px**.
 *
 * Measured in the browser rather than left as arithmetic, because the margin is smaller
 * than the estimate suggests. The cutout's left edge is 187.5px. The clock's widest
 * reading measures 62.2px, and a three-glyph `+10` chip is 19.4px rather than 18 — so the
 * genuine worst case, widest clock and three-glyph chip together, ends at **183.7px and
 * clears by 3.8px**. It clears, which is why 3 is the cap; but the headroom is under four
 * pixels, so treat this row as full. A fourth icon ends past 200px and is inside the hole.
 *
 * One of the three is spoken for while music is loaded (MICA-111). The status bar's music
 * glyph moved out of the right-hand device-state group and into this row, because the shade
 * presents now-playing as a persistent notification and an icon for a notification belongs
 * with the notification icons. It **occupies a slot** rather than extending the row — at
 * three glyphs and a chip the arithmetic above is untouched, which is the only reason the
 * move was affordable at 3.8px of headroom. It is placed first and is never the one the
 * `+N` chip stands in for; `PhoneFrame.svelte` argues both.
 *
 * It was 5, chosen the same way but without accounting for the icons' own gaps: five icons
 * end at exactly 188px, which is why the fifth was reported half-swallowed by the cutout.
 * A fourth icon would fit on its own, but not alongside the chip that has to sit after it,
 * and a cap that changes with the count is a rule nobody can check by looking at the bar.
 *
 * Written as a function of the frame (MICA-258), so a wider device gets the cap its own bar
 * has room for from the same arithmetic rather than a second hand-derived number. The
 * terms are the ones measured above: the fixed part of the row (the `px-8` start, the
 * widest clock, the two gaps, a two-glyph chip) and 18px per icon. With a hole-punch the row
 * stops at the cutout's left edge; without one it has the bar minus the right-hand cluster,
 * capped where a longer row stops being a glance. The phone's answer is still 3, and
 * `display.test.ts` holds it there.
 */
const STATUS_BAR_ROW_FIXED_PX = 32 + 62 + 8 + 4 + 18;
const STATUS_BAR_ICON_STEP_PX = 18;
const STATUS_BAR_CUTOUT_HALF_PX = 12;
const STATUS_BAR_RIGHT_CLUSTER_PX = 32 + 90;
const STATUS_BAR_ICON_CAP_WITHOUT_CUTOUT = 8;

export const statusBarIconCap = (frameWidth: number, holePunch: boolean): number => {
  const roomFor = (rightEdge: number) =>
    Math.max(0, Math.floor((rightEdge - STATUS_BAR_ROW_FIXED_PX) / STATUS_BAR_ICON_STEP_PX));
  if (holePunch) return roomFor(frameWidth / 2 - STATUS_BAR_CUTOUT_HALF_PX);
  return Math.min(
    STATUS_BAR_ICON_CAP_WITHOUT_CUTOUT,
    roomFor(frameWidth - STATUS_BAR_RIGHT_CLUSTER_PX)
  );
};

export const STATUS_BAR_MAX_NOTIFICATION_ICONS = statusBarIconCap(
  PHONE_WIDTH,
  DEVICES.phone.chrome.holePunch
);

/**
 * Breathing room between the phone and the edge of the window, in CSS pixels.
 *
 * Two values rather than one because the large one is a third of a phone-sized viewport.
 * The small one still has to clear the hardware buttons, which sit 13px outside the frame
 * and would otherwise be shaved off by the window edge.
 */
export const MARGIN_LARGE = 48;
export const MARGIN_SMALL = 16;
const SMALL_VIEWPORT = 640;

/**
 * Breathing room yields before the phone does.
 *
 * The large margin costs 96px of height, and the phone needs 850 of it — so on a maximised
 * browser at 1080p, which has roughly 950 after OS and browser chrome, those 96px are the
 * difference between reaching design size and not. Generous spacing is a nicety; drawing
 * the phone at the size the player asked for is the point, so the margin gives way first.
 */
export const marginFor = (
  width: number,
  height: number,
  design: DeviceFrame = DEVICES.phone.frame
): number => {
  const base = Math.min(width, height) < SMALL_VIEWPORT ? MARGIN_SMALL : MARGIN_LARGE;

  // The largest margin that still leaves the phone its design height, never below the
  // small one — which has its own job: the hardware buttons sit 13px outside the frame and
  // would be shaved off by the window edge.
  //
  // Continuous rather than a step down from large to small, and that matters: a two-step
  // rule made a 900px window allow a *larger* phone than a 950px one, because the smaller
  // window crossed the threshold and got 32px back while the larger one kept paying 96.
  const spare = Math.floor((height - design.height) / 2);
  return Math.min(base, Math.max(MARGIN_SMALL, spare));
};

/**
 * The Display setting: 0-100, in the middle by default.
 *
 * Stored as the slider's own number rather than a scale factor, because that is the unit
 * the setting is expressed in and it is what survives a change to the range below.
 */
export const DISPLAY_SIZE_DEFAULT = 50;
export const MIN_SCALE = 0.6;
export const MAX_SCALE = 1.4;

/** A stored value that is not a number in range comes back as the default (§usePersisted). */
const sanitizeSize = (value: unknown): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 100) return DISPLAY_SIZE_DEFAULT;
  return n;
};

/**
 * One value per device, following `activeDevice` (MICA-261). A 40% phone is a phone
 * held close; a 40% tablet is unreadable, and the two are size-limited on different
 * windows anyway. The phone's key is unchanged, so an existing setting still means the
 * phone; the tablet's is `displaySize:tablet`.
 */
export const displaySize = perDevice<number>(
  'displaySize',
  () => DISPLAY_SIZE_DEFAULT,
  (value) => sanitizeSize(value)
);

export const setDisplaySize = (size: number) => displaySize.set(size);

/**
 * Slider position to zoom factor, across the range the window can actually draw.
 *
 * `maxScale` is what makes this usable rather than a detail. It used to map onto a fixed
 * `MIN_SCALE`–`MAX_SCALE` and then get clamped by the fit afterwards, which meant every
 * position above the fit produced the same number: on a 950px-tall window the fit is
 * almost exactly 1, so **50 through 100 all rendered identically** and half the control
 * did nothing. Ending the range at what fits means every position moves the phone, on
 * every window.
 *
 * The trade is that a stored value is a proportion of the available range rather than a
 * fixed zoom, so the phone follows the window as it is resized. That is the honest
 * reading of a size slider whose ceiling the window owns — and the old model was not
 * actually stable either, since a stored 75 already rendered 0.95 on one window and 1.20
 * on another. It only looked stable.
 *
 * `maxScale` is floored at `MIN_SCALE` so a viewport too small for even the smallest
 * phone collapses to a point rather than inverting the range.
 */
export const scaleForSize = (size: number, maxScale: number = MAX_SCALE): number => {
  const top = Math.max(MIN_SCALE, Math.min(MAX_SCALE, maxScale));
  return MIN_SCALE + (sanitizeSize(size) / 100) * (top - MIN_SCALE);
};

export interface ViewportSize {
  width: number;
  height: number;
}

const measure = (): ViewportSize =>
  typeof window === 'undefined'
    ? { width: 0, height: 0 }
    : { width: window.innerWidth, height: window.innerHeight };

export const viewportSize = writable<ViewportSize>(measure());

/**
 * Follow the window.
 *
 * `100vh` cannot do this job. In CEF it is right, but in a mobile browser it is the
 * viewport *including* the retracted URL bar, so a phone anchored to the bottom of it
 * sits partly below the fold — and the dynamic units that fix it (`dvh`) need Chromium
 * 108, eight versions above the CEF baseline (AGENTS.md §6). A measured pixel value is
 * correct in both.
 *
 * The typing guard is for the on-screen keyboard: Chrome on Android shrinks the layout
 * viewport when it opens, and without this the whole phone would shrink to half size the
 * moment you tapped a message field. Width still tracks, so a rotation while typing is
 * not ignored.
 */
export function observeViewport(): () => void {
  if (typeof window === 'undefined') return () => {};

  const update = () => {
    const next = measure();
    const current = get(viewportSize);
    const keyboardIsUp = isTypingTarget(document.activeElement) && next.height < current.height;
    viewportSize.set(keyboardIsUp ? { width: next.width, height: current.height } : next);
  };

  update();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
  };
}

/**
 * The largest zoom the window has room for.
 *
 * An unmeasured viewport must not clamp anything — jsdom and a pre-mount render both
 * report zero, and a fit of zero is an invisible phone.
 *
 * `design` defaults to the phone so every existing caller and test reads as before; the
 * store below passes the active device's frame, which is how a 1280px-wide tablet ends up
 * size-limited on a window the phone fits in with room to spare.
 */
export const fitScaleFor = (
  { width, height }: ViewportSize,
  design: DeviceFrame = DEVICES.phone.frame
): number => {
  const margin = marginFor(width, height, design);
  const available = { width: width - margin * 2, height: height - margin * 2 };
  if (available.width <= 0 || available.height <= 0) return MAX_SCALE;
  return Math.min(available.width / design.width, available.height / design.height);
};

/** Likewise internal; `fitScaleFor` is the exported, testable half. */
const fitScale = derived([viewportSize, frame], ([$viewport, $frame]) =>
  fitScaleFor($viewport, $frame)
);

/** The margin actually in use, so `Shell` pads by exactly what the fit assumed. */
export const frameMargin = derived([viewportSize, frame], ([{ width, height }, $frame]) =>
  marginFor(width, height, $frame)
);

/**
 * Set by the camera around a capture, to draw the phone at its largest normal size
 * instead of the player's Display setting for that one frame.
 *
 * A bigger on-screen phone means `screencapture` grabs more real pixels for the same
 * viewfinder crop, which is the whole point — the alternative is upscaling the smaller
 * capture afterwards, which is interpolation blur with no extra detail behind it. This
 * never touches `displaySize` itself, so the player's own setting is untouched once the
 * capture is done.
 */
// MICA-172: the store moved to `sdk/host/seam/captureZoom.ts`; re-exported so every
// existing `shell/state/display` importer is untouched. See that file for why.
export { captureZoomBoost };

/**
 * What the phone is drawn at.
 *
 * The fit is folded into the *range* rather than applied as a clamp afterwards, which is
 * the whole fix — see `scaleForSize`. `Math.min` still guards the floor case, where the
 * window cannot fit even `MIN_SCALE` and the range has nowhere left to go.
 *
 * The capture boost is clamped to `MAX_SCALE` rather than handed the raw fit: `fitScale`
 * is capped by the *window*, not by the phone's normal size range, and a wide-but-short
 * monitor (a 5120x1440 ultrawide, say) fits a taller scale than any Display setting ever
 * produces. Drawing the phone bigger than it is ever normally allowed to render for a
 * capture would exercise a size nothing else in the shell expects.
 */
export const phoneScale = derived(
  [displaySize, fitScale, captureZoomBoost],
  ([$size, $fit, $boost]) =>
    $boost ? Math.min(MAX_SCALE, $fit) : Math.min(scaleForSize($size, $fit), $fit)
);

/** The scaled box, which is what the flex layout has to reserve — a transform does not. */
export const phoneBox = derived([phoneScale, frame], ([$scale, $frame]) => ({
  width: $frame.width * $scale,
  height: $frame.height * $scale
}));

/**
 * True when the window is what caps the top of the range.
 *
 * It used to mean "the fit is overriding your setting", which stopped being expressible
 * once the fit became the top of the range — nothing is overridden any more. What is
 * still worth telling the player is that the largest setting is smaller here than it
 * would be on a bigger window, which is why the slider stops where it does.
 */
export const isSizeLimited = derived(fitScale, ($fit) => $fit < MAX_SCALE);
