// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hydrateSettings`, and the one-slot seam behind it.
 *
 * MICA-176. `hydrateSettings` is on the public surface in both directions, but it only
 * ever *does* anything in the shell: it copies this character's saved settings out of the
 * database into the storage cache and re-reads every live persisted store. Inside a
 * sandboxed add-on there is nothing to fetch — the frame's storage arrives synchronously in
 * its `hydrate` message (`iframe/storageCache.ts`) — so the iframe twin of this was an
 * empty `async function` whose own doc comment said it existed only because
 * `useStorage.ts` re-exported the name "from whichever `storage` twin the build resolves
 * to, and the module graph needs the export to exist either way".
 *
 * That "whichever the build resolves to" was `facetSwap()` in `vite.addon.config.ts`, which
 * this ticket deletes. So the choice moves to where every other one did: the entry point.
 * `inProcess/facets/storage.ts` installs the real implementation at import time, right
 * beside its `registerFacet` calls, and is reached only through
 * `inProcess/registerFacets.ts` — which only `src/main.ts` imports. An add-on bundle never
 * loads that module, so the default below stands and the apologetic empty twin is gone.
 *
 * The no-op default is the honest answer for a frame rather than a fallback for a mistake:
 * an add-on's settings are already hydrated by the time its code runs.
 *
 * `registerSettingsHydrator` is **not** exported from `@gos/sdk` — it is not in
 * `host/index.ts` (the barrel covers `host/*.ts`, not `host/seam/*.ts`) and nothing
 * re-exports it. `publicSurface.test.ts` is what would notice if that changed.
 */

type Hydrator = () => Promise<void>;

const noop: Hydrator = async () => {};

let hydrator: Hydrator = noop;

/** @internal Install the in-process implementation. Called by `inProcess/facets/storage.ts`. */
export function registerSettingsHydrator(fn: Hydrator): void {
  hydrator = fn;
}

/**
 * Copy this character's saved settings into the cache and re-read every live store.
 *
 * Runs at page load and again on every character load. The CEF page never unloads, so
 * switching character without a resource restart would otherwise leave the previous
 * character's phone on screen.
 *
 * A no-op inside a sandboxed add-on — see this module's doc comment.
 */
export function hydrateSettings(): Promise<void> {
  return hydrator();
}
