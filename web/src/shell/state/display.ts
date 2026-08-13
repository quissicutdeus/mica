import { derived, get, writable } from 'svelte/store';
import { usePersisted } from '../../sdk/hooks/usePersisted';
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
export const PHONE_WIDTH = 400;
const PHONE_DESIGN_HEIGHT = 850;
export const PHONE_HEIGHT = PHONE_DESIGN_HEIGHT;

/**
 * How far, in phone-design px, a finger has to travel to fully reveal or dismiss the
 * notification shade by drag. Shared by the status-bar open-drag and the shade's own
 * grab-handle close-drag so the two gestures feel symmetric — equal to `PHONE_HEIGHT`
 * (850px) so the panel tracks the finger 1:1 with zero offset across the full screen.
 *
 * Sourced from the same private constant as `PHONE_HEIGHT` rather than from that export
 * directly, so the two read as independently-named quantities that happen to coincide
 * (per the paragraph above) instead of one export aliasing another.
 */
export const SHADE_DRAG_REVEAL_DISTANCE = PHONE_DESIGN_HEIGHT;

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
export const marginFor = (width: number, height: number): number => {
  const base = Math.min(width, height) < SMALL_VIEWPORT ? MARGIN_SMALL : MARGIN_LARGE;

  // The largest margin that still leaves the phone its design height, never below the
  // small one — which has its own job: the hardware buttons sit 13px outside the frame and
  // would be shaved off by the window edge.
  //
  // Continuous rather than a step down from large to small, and that matters: a two-step
  // rule made a 900px window allow a *larger* phone than a 950px one, because the smaller
  // window crossed the threshold and got 32px back while the larger one kept paying 96.
  const spare = Math.floor((height - PHONE_HEIGHT) / 2);
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

export const displaySize = usePersisted<number>('settings', 'displaySize', DISPLAY_SIZE_DEFAULT, {
  sanitize: sanitizeSize
});

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
 */
export const fitScaleFor = ({ width, height }: ViewportSize): number => {
  const margin = marginFor(width, height);
  const available = { width: width - margin * 2, height: height - margin * 2 };
  if (available.width <= 0 || available.height <= 0) return MAX_SCALE;
  return Math.min(available.width / PHONE_WIDTH, available.height / PHONE_HEIGHT);
};

/** Likewise internal; `fitScaleFor` is the exported, testable half. */
const fitScale = derived(viewportSize, fitScaleFor);

/** The margin actually in use, so `Shell` pads by exactly what the fit assumed. */
export const frameMargin = derived(viewportSize, ({ width, height }) => marginFor(width, height));

/**
 * What the phone is drawn at.
 *
 * The fit is folded into the *range* rather than applied as a clamp afterwards, which is
 * the whole fix — see `scaleForSize`. `Math.min` still guards the floor case, where the
 * window cannot fit even `MIN_SCALE` and the range has nowhere left to go.
 */
export const phoneScale = derived([displaySize, fitScale], ([$size, $fit]) =>
  Math.min(scaleForSize($size, $fit), $fit)
);

/** The scaled box, which is what the flex layout has to reserve — a transform does not. */
export const phoneBox = derived(phoneScale, ($scale) => ({
  width: PHONE_WIDTH * $scale,
  height: PHONE_HEIGHT * $scale
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
