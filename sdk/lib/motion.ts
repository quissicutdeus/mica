// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fade as svelteFade, fly as svelteFly } from 'svelte/transition';
import type { FadeParams, FlyParams, TransitionConfig } from 'svelte/transition';

/**
 * `svelte/transition`'s `fade` and `fly`, with the player's motion setting applied
 * (MICA-66).
 *
 * ## Why these have to exist at all
 *
 * The `[data-reduced-motion='true']` block in `app.css` neutralizes every CSS animation
 * and transition in the phone, and it does not touch a single Svelte `transition:`
 * directive. Svelte 5 runs those through the Web Animations API —
 * `element.animate(keyframes, { duration })`, in
 * `svelte/src/internal/client/dom/elements/transitions.js` — and a script animation takes
 * its timing from that JavaScript options object. No CSS declaration reaches it,
 * `!important` included. (Svelte 4 emitted a `@keyframes` rule and an inline `animation`,
 * which is where the belief that a stylesheet covers this comes from. It stopped being
 * true at Svelte 5.)
 *
 * So the phone's most visible animations — the fly-in, the drawer, the shade, toasts —
 * are exactly the ones a stylesheet cannot stop, and a `duration:` in the markup has to
 * be told. These wrappers are how: identical signatures, so a call site changes its
 * import line and keeps its own numbers. `shell/state/motion.test.ts` fails if anything
 * imports `svelte/transition` directly.
 *
 * ## Why this reads the DOM rather than the store
 *
 * `shell/state/motion.ts` owns the preference and is the source of truth. This file
 * cannot import it: `sdk/ui` needs these wrappers, and `sdk/ui` is compiled into the
 * add-on kit bundle, which has no shell to reach (`sdk/seam.test.ts`).
 *
 * Reading the attribute the store publishes is not a workaround for that — it is the
 * better answer. `observeReducedMotion` writes `data-reduced-motion` on the document
 * element, `app.css` selects on it, and this reads it, so the two halves of the feature
 * consume one published fact and cannot disagree about what the player asked for.
 *
 * Inside a sandboxed add-on frame the attribute is simply absent — the shell cannot write
 * into a document at an opaque origin — so an add-on animates normally and reads the
 * preference through `useDisplay().reducedMotion` if it wants to honour it. Its CSS is
 * its own for the same reason.
 */
export const prefersReducedMotion = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dataset.reducedMotion === 'true';

/** A delay is motion the player is made to wait through, so it goes with the animation. */
const still = <P extends { duration?: number; delay?: number }>(params?: P): P =>
  ({ ...(params ?? {}), duration: 0, delay: 0 }) as P;

export const fade = (node: Element, params?: FadeParams): TransitionConfig =>
  svelteFade(node, prefersReducedMotion() ? still(params) : params);

export const fly = (node: Element, params?: FlyParams): TransitionConfig =>
  svelteFly(node, prefersReducedMotion() ? still(params) : params);
