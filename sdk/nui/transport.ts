// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The NUI transport seam: what `fetchNui` means, decided by whoever booted.
 *
 * MICA-172. `useNuiBridge` and the two store factories called `web/src/nui/fetchNui`
 * directly, and `vite.addon.config.ts` aliased that specifier to
 * `sdk/host/iframe/fetchNui.ts` for an add-on build. Same story as the facets before
 * MICA-176: one source line, two resolutions, decided by a build alias — and across a
 * package boundary an alias is a resolution error rather than a configuration choice.
 *
 * `web/src/nui/fetchNui.ts` cannot come into the package. It reaches `nui/transport.ts`,
 * which reaches `nui/mocks/registry.ts` — the browser mock registry, which answers by
 * action name and therefore knows every app's actions. That is irreducibly phone-side.
 *
 * So the same shape used for facets and for `settingsHydration`: the SDK declares the
 * binding, and an entry point installs the implementation. The phone's transport registers
 * itself at the bottom of `web/src/nui/fetchNui.ts`; the sandboxed twin registers itself at
 * the bottom of `sdk/host/iframe/fetchNui.ts`, which `bootAddOn` imports. Nothing else
 * chooses, and the add-on build needs no alias for it.
 *
 * Unregistered is a **throw**, not a silent default. A transport that quietly resolved to
 * nothing would turn every server round trip into a hanging promise or a default value, and
 * `fetchNui`'s whole documented hazard (AGENTS.md §8) is that a missing layer fails silently
 * while every suite stays green. If this throws, the bundle never installed a transport —
 * the message says which import is missing.
 */

/** The one shape both sides implement. `defaultValue` is what a missing server half returns. */
export type FetchNui = <T = unknown>(
  eventName: string,
  data?: unknown,
  options?: { defaultValue?: T }
) => Promise<T>;

let transport: FetchNui | undefined;

/**
 * Install this bundle's transport. Called at the bottom of `web/src/nui/fetchNui.ts` (the
 * phone) and `sdk/host/iframe/fetchNui.ts` (a sandboxed add-on). Last writer wins, so a test
 * may install a stub over either.
 */
export function registerNuiTransport(fn: FetchNui): void {
  transport = fn;
}

/**
 * Call the installed transport.
 *
 * A wrapper rather than a re-exported binding, for the reason `useNuiBridge`'s own doc
 * gives at length: re-reading the binding on every call is what makes destructuring at
 * module scope safe, so a test that installs a stub later is actually seen.
 */
export const fetchNui: FetchNui = (...args) => {
  const [eventName] = args;
  if (!transport) {
    throw new Error(
      `[micaOS] no NUI transport is installed, so '${eventName}' has nowhere to go. The phone ` +
        `installs one by importing 'web/src/nui/fetchNui'; a sandboxed add-on gets one from ` +
        `bootAddOn. A unit test that exercises a server round trip needs whichever of those ` +
        `matches the side it is standing in for.`
    );
  }
  // Spread, not `(eventName, data, options)`. Forwarding a fixed three arguments turns a
  // two-argument call into a three-argument one with a trailing `undefined` — no runtime
  // difference, and it breaks every `toHaveBeenCalledWith` asserting the real call shape.
  // A seam has to be arity-transparent or it is not transparent.
  return transport(...args);
};
