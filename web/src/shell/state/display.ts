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
export const PHONE_HEIGHT = 850;

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

export const marginFor = (width: number, height: number): number =>
  Math.min(width, height) < SMALL_VIEWPORT ? MARGIN_SMALL : MARGIN_LARGE;

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
 * Slider position to zoom factor. The midpoint is deliberately exactly 1 — the size the
 * phone has always been drawn at — so the shipped default changes nothing on a window
 * with room for it.
 */
export const scaleForSize = (size: number): number =>
  MIN_SCALE + (sanitizeSize(size) / 100) * (MAX_SCALE - MIN_SCALE);

/** What the setting asks for, before the window has a say. Not exported: `phoneScale` is
 * the only honest answer to "how big is the phone", and two similarly-named stores where
 * one of them ignores the window is an invitation to read the wrong one. */
const requestedScale = derived(displaySize, scaleForSize);

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
 * What the phone is drawn at: what the player asked for, or what fits, whichever is
 * smaller. The setting is a preference; fitting is not.
 */
export const phoneScale = derived([requestedScale, fitScale], ([$requested, $fit]) =>
  Math.min($requested, $fit)
);

/** The scaled box, which is what the flex layout has to reserve — a transform does not. */
export const phoneBox = derived(phoneScale, ($scale) => ({
  width: PHONE_WIDTH * $scale,
  height: PHONE_HEIGHT * $scale
}));

/** True when the window, not the setting, is deciding the size. Settings says so. */
export const isSizeLimited = derived(
  [requestedScale, fitScale],
  ([$requested, $fit]) => $fit < $requested
);
