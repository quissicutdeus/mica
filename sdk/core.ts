// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@gos/sdk/core` — the surface only a `core: true` app may import.
 *
 * `useNuiBridge` is the raw transport: any registered NUI callback, by name. An add-on
 * with it can reach everything every other permission guards, so it is not on
 * `@gos/sdk` — `boundary.test.ts` refuses it to anything `core: false`. The specifier
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
 * public `@gos/sdk` would make a screen-sized component with one subject into an API
 * commitment to every add-on; putting it here keeps it reachable by the two things that
 * draw it. It grants nothing on its own: it is presentational, and the stores it renders
 * from are `useMusic()`'s, which is permission-gated as it always was.
 */
export { useNuiBridge } from './useNuiBridge';
export { useCaptureZoomBoost } from './useCaptureZoomBoost';
export { default as NowPlayingCard } from './ui/NowPlayingCard.svelte';
