import { derived, readable } from 'svelte/store';
import { usePersisted } from '../../sdk/host/usePersisted';

/**
 * Whether the phone animates, and the one place that question is answered.
 *
 * State the phone itself owns, so it lives here rather than in `services/` — no server,
 * no table. Modeled on `theme.ts`: a `usePersisted` store, a derived view, no DOM access
 * beyond the one media query below.
 *
 * ## Why there is a setting at all, and not just the media query
 *
 * `prefers-reduced-motion` is Chrome 74, comfortably under the CEF 103 floor (AGENTS.md
 * §6), so the query itself is safe to ask. What is *not* safe is assuming the answer
 * means anything in game: CEF is a browser embedded in a game process, and whether it
 * inherits the host OS's animation preference is not something this repo can promise on
 * every platform a server runs on. A player on a Windows box with "Show animations"
 * turned off may still be told `no-preference` here.
 *
 * So the query is the *default*, and the player can override it either way. `'system'`
 * follows the query; `'reduced'` and `'full'` do not.
 *
 * ## Where the truth lives
 *
 * This module, and only this module, reads the media query — exactly once, in
 * `systemPrefersReducedMotion`. `reducedMotion` folds the player's choice over it, and
 * `Shell.svelte` writes the result to `document.documentElement.dataset.reducedMotion`,
 * which is what the `[data-reduced-motion='true']` block in `app.css` keys off.
 *
 * There is deliberately **no bare `@media (prefers-reduced-motion: reduce)` block in the
 * stylesheet**. A second reader of the same query would be a second source of truth, and
 * the two would disagree in the one case that matters: a player who has explicitly chosen
 * `'full'` on a machine whose OS asks for reduce would get their animations back from the
 * store and lose them again to the media query, with nothing in the UI to explain it.
 * One reader, one answer.
 *
 * ## Two mechanisms, one answer — and why the stylesheet is not enough on its own
 *
 * The phone animates in two different ways, and a single hook does not cover both.
 *
 * **CSS** — `transition-colors` and friends, the `.animate-*` utilities, the sheets'
 * `transition-transform` while settling, the camera's inline `transition:` style. The
 * `[data-reduced-motion='true']` block in `app.css` neutralizes all of it.
 *
 * **Svelte `transition:` directives** — the phone's fly-in, the drawer, the shade, toasts.
 * These are *not* CSS. Svelte 5 runs a transition through the Web Animations API
 * (`element.animate(keyframes, { duration })` in
 * `svelte/src/internal/client/dom/elements/transitions.js`), and a script animation takes
 * its timing from that options object — no CSS declaration, `!important` or otherwise,
 * can touch it. Svelte 4 did emit a `@keyframes` rule and an inline `animation`, which is
 * where the belief that a stylesheet covers this comes from; it stopped being true at
 * Svelte 5. **A `duration:` in the markup therefore has to be told**, which is what the
 * `fade`/`fly` wrappers in `lib/motion.ts` do — drop-in replacements a call site adopts by
 * changing one import line. They live there rather than here because `sdk/ui` needs them
 * and `sdk/ui` ships in the add-on kit bundle, which has no shell (`sdk/seam.test.ts`).
 * `motion.test.ts` fails if anything imports `svelte/transition` directly.
 *
 * That is still one source of truth: `observeReducedMotion` below publishes this store's
 * answer as an attribute on the document, and both the stylesheet and the wrappers read
 * that one attribute. Neither asks the platform.
 *
 * What neither half reaches: a `scrollIntoView({ behavior: 'smooth' })` call, whose
 * `behavior` argument outranks the `scroll-behavior` property, and any animation driven by
 * a `requestAnimationFrame` loop of its own. Those are per-call-site problems.
 */

export type MotionPreference = 'system' | 'full' | 'reduced';

export const MOTION_PREFERENCE_DEFAULT: MotionPreference = 'system';

/** The media query, exported so a test can name the same string the store listens to. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A stored value is a value a player can edit; anything unrecognized is the default. */
export const sanitizeMotionPreference = (stored: unknown): MotionPreference =>
  stored === 'full' || stored === 'reduced' || stored === 'system'
    ? stored
    : MOTION_PREFERENCE_DEFAULT;

export const motionPreference = usePersisted<MotionPreference>(
  'settings',
  'motionPreference',
  MOTION_PREFERENCE_DEFAULT,
  { sanitize: sanitizeMotionPreference }
);

export const setMotionPreference = (preference: MotionPreference) =>
  motionPreference.set(sanitizeMotionPreference(preference));

const queryList = (): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(REDUCED_MOTION_QUERY);

/**
 * What the platform says, live.
 *
 * `readable` rather than a one-shot read because the preference can change while the
 * phone is open — a player toggling it in Windows settings mid-session should not have to
 * restart the resource. The listener is only attached while something is subscribed,
 * which is the store's own contract and costs nothing when nothing is watching.
 */
export const systemPrefersReducedMotion = readable(queryList()?.matches ?? false, (set) => {
  const list = queryList();
  if (!list) return;

  set(list.matches);
  const onChange = (event: MediaQueryListEvent) => set(event.matches);

  // `addEventListener` on a MediaQueryList is Chrome 39 and fine at the CEF floor; the
  // `addListener` fallback is for a host that hands us an older shim (jsdom's stub has
  // varied on this across versions, and a store that throws at import would take the
  // whole shell down with it).
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  list.addListener?.(onChange);
  return () => list.removeListener?.(onChange);
});

/** The answer. `'system'` defers to the platform; the other two do not. */
export const reducedMotion = derived(
  [motionPreference, systemPrefersReducedMotion],
  ([$preference, $system]) => ($preference === 'system' ? $system : $preference === 'reduced')
);

/**
 * Publish the answer to the document, which is how both halves of the feature read it.
 *
 * `app.css` selects on `html[data-reduced-motion='true']` for everything CSS can reach,
 * and `lib/motion.ts`'s `fade`/`fly` read the same attribute for the Svelte `transition:`
 * directives CSS cannot (see that file — Svelte 5 runs them on the Web Animations API).
 * One published fact, so the two cannot disagree.
 *
 * A subscription rather than an `$effect` in `Shell.svelte`, and shaped like
 * `observeViewport` in `display.ts`: the DOM write belongs next to the state it publishes,
 * where it can be tested without rendering the whole phone.
 */
export function observeReducedMotion(): () => void {
  if (typeof document === 'undefined') return () => {};
  return reducedMotion.subscribe((on) => {
    document.documentElement.dataset.reducedMotion = on ? 'true' : 'false';
  });
}
