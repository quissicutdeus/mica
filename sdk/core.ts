// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@mica/sdk/core` — the surface only a `core: true` app may import.
 *
 * `useNuiBridge` is the raw transport: any registered NUI callback, by name. An add-on
 * with it can reach everything every other permission guards, so it is not on
 * `@mica/sdk` — `boundary.test.ts` refuses it to anything `core: false`. The specifier
 * is unresolvable out-of-tree for a Store-installed bundle, and since MICA-16 Step 4
 * that is also a runtime refusal: a `core: false` bundle runs in a sandboxed iframe with
 * no NUI at all, only the `postMessage` protocol in `sdk/host/iframe/`. In-process,
 * `useNuiBridge` is gated only by the static `core:`-only import check; it has no
 * host-protocol permission row and is not `guarded()`.
 *
 * `useCaptureZoomBoost` is here for the same reason, not because it needs the transport:
 * it is a lever on the shell's own rendering with no legitimate reason for a sandboxed
 * add-on to pull it.
 *
 * `NowPlayingCard` is the third kind: not dangerous, not general. It is the transport for
 * the phone's *own* player, drawn by the Music app and by the notification shade, and it
 * is the reason Music is `core: true` at all — the player is hardware. Putting it on the
 * public `@mica/sdk` would make a screen-sized component with one subject into an API
 * commitment to every add-on; putting it here keeps it reachable by the two things that
 * draw it. It grants nothing on its own: it is presentational, and the stores it renders
 * from are `useMusic()`'s, which is permission-gated as it always was.
 *
 * The seed-theming set — `DEFAULT_SEED`, `sanitizeSeed`, `seedFromRgbString`,
 * `buildSchemes`, `cssVarBlock`, `backgroundForScheme` — is the fourth kind, and it is
 * here for cost rather than for danger. MICA-187 decided where it publishes, with the
 * number from MICA-181 in hand: `buildSchemes` drags `@material/material-color-utilities`
 * into whatever bundle can reach it, about 21 kB gzipped, and Rollup does not shake it
 * back out of a `core: false` add-on that never calls it. `@mica/sdk/core` has no alias in
 * `vite.addon.config.ts` at all, so nothing published here can enter an add-on bundle —
 * MICA-187 rebuilt all four add-ons before and after this export landed and the bundles
 * were byte-identical. The only consumer in the tree, `NowPlayingCard`, is already on this
 * entry point, so a core app deriving a scheme from a *different* seed than the phone's
 * pays for an engine the shell has loaded anyway. An add-on theming itself to the phone
 * gets the *current* scheme through `useTheme().schemeStore`, which is what it actually
 * needs; deriving one from an arbitrary seed stays off `@mica/sdk` until a real add-on
 * asks and the 21 kB is weighed against it. `host/seam/theme.ts` keeps the longer account.
 */
export { useNuiBridge } from './useNuiBridge';
export { useCaptureZoomBoost } from './useCaptureZoomBoost';
export { default as NowPlayingCard } from './ui/NowPlayingCard.svelte';
export {
  DEFAULT_SEED,
  sanitizeSeed,
  seedFromRgbString,
  backgroundForScheme,
  buildSchemes,
  cssVarBlock
} from './host/seam/theme';
