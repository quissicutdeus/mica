// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether this player reads clocks in 24-hour time, and the one-slot seam behind it.
 *
 * MICA-172. `formatTime` in `sdk/lib/formatters.ts` needs this for its default, and
 * `formatters` is re-exported from `@mica/sdk`'s `utils.ts` — so it is reachable from
 * every add-on and from every corner of the shell. It used to reach the value by importing
 * `is24Hour` directly out of `shell/state/time.ts`, and that single import was the last
 * value edge from the SDK into the phone.
 *
 * **It was also a boot failure, not merely an untidy dependency.** `shell/state/time.ts`
 * calls `usePersisted('settings', 'is24Hour', …)` at *module scope*. Importing it from the
 * SDK put that call inside the shared `sdk-*.js` chunk — and that chunk is a dependency of
 * `host/registerFacets.ts`, so ES semantics evaluate it **before** the registration side
 * effects it depends on. The built phone died on first paint with `host facet 'persisted'
 * is not loaded`, while every unit test passed: a test imports the facet set as its first
 * import and never reproduces the chunk ordering. Only a real boot showed it.
 *
 * So the value arrives the way the transport and the settings hydrator already do — the
 * entry point installs it:
 *
 * - the shell's `host/facets/clock.ts` installs the real `is24Hour` store beside its own
 *   `registerFacet` call, and is reached only through `host/registerFacets.ts`;
 * - the add-on side installs the frame's equivalent from `iframe/facets/clock.ts`.
 *
 * A plain getter rather than a store, deliberately. `formatTime` reads the value
 * **synchronously** during first paint, which is exactly why the iframe shim refused to
 * make `is24Hour` a `remoteStore` — a subscription hands back its seed and only later holds
 * the truth, so every call before the reply lands formats in the wrong clock. A getter
 * cannot develop that gap.
 *
 * The default is 12-hour. That is the honest answer for "nobody has said" rather than a
 * fallback for a mistake: it is what `shell/state/time.ts` itself defaults to, so a bundle
 * that never installs a preference formats the way an uninitialised phone would.
 *
 * `registerClockPreference` is **not** exported from `@mica/sdk` — it is not in
 * `host/index.ts` (the barrel covers `host/*.ts`, not `host/seam/*.ts`) and nothing
 * re-exports it. `publicSurface.test.ts` is what would notice if that changed.
 */

type ClockPreference = () => boolean;

const twelveHour: ClockPreference = () => false;

let preference: ClockPreference = twelveHour;

/** @internal Install the real preference. Called by each side's `clock` facet. */
export function registerClockPreference(fn: ClockPreference): void {
  preference = fn;
}

/**
 * Does this player read clocks in 24-hour time?
 *
 * Synchronous by contract — see this module's doc comment for why a store would be wrong
 * here even though the underlying state is one.
 */
export function is24HourNow(): boolean {
  return preference();
}
