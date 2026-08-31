/**
 * The live-`usePersisted`-store registry, shared by both sides of the host seam.
 *
 * MICA-176. This was two byte-identical copies — one in `inProcess/facets/storage.ts`,
 * one in `iframe/facets/storage.ts` — and `useStorage.ts` re-exported whichever one the
 * add-on build's deleted `facetSwap()` plugin happened to resolve. The bookkeeping itself
 * has no side: it is two collections of callbacks belonging to *this* JS context, and a
 * bundle only ever contains one of the two facet sets, so one module serves both and there
 * is nothing left for a resolver plugin to choose between.
 *
 * Deliberately free of `shell/`, `services/` and `nui/` — `seam.test.ts` checks that for
 * everything under `sdk/host/` outside `inProcess/`, and this file is on an add-on's graph.
 *
 * Two registries, not one, and the distinction is load-bearing:
 *
 * - **reset** sets a store back to its shipped default. That is the right answer for "this
 *   app's storage was cleared" and the wrong one for "the server just told us what this
 *   character had" — reusing it there would blank every preference at the exact moment the
 *   real values arrived.
 * - **rehydrate** re-reads the store's key from the backend, which is the hydration answer.
 *
 * A registry rather than an event because the reset has to reach the *inner* writable:
 * `usePersisted`'s own `set` persists, so resetting through it would recreate the key it
 * was just asked to delete. And a registry is needed at all because a persisted store reads
 * its key exactly once, at construction — which for every one of them is module scope, and
 * the CEF page never unloads. Sweeping the keys alone left the old value on screen and the
 * store's next write put the key straight back.
 *
 * Stores are never disposed — they live in module scope for the life of the page — so there
 * is nothing to unregister and no leak in keeping them.
 */

const persistedResets = new Map<string, Set<() => void>>();
const persistedRehydrators = new Set<() => void>();

/** Internal, for `usePersisted`. Not something an app has a reason to call. */
export function registerPersistedReset(appId: string, reset: () => void): void {
  const existing = persistedResets.get(appId);
  if (existing) existing.add(reset);
  else persistedResets.set(appId, new Set([reset]));
}

/** Internal, for `usePersisted`. Stores live for the life of the page, so nothing unregisters. */
export function registerPersistedRehydrate(rehydrate: () => void): void {
  persistedRehydrators.add(rehydrate);
}

/** Every reset callback registered for one app. Used by `clearAppStorage` on both sides. */
export function persistedResetsFor(appId: string): Iterable<() => void> {
  return persistedResets.get(appId) ?? [];
}

/** Every rehydrate callback in this context. Used by the in-process settings hydrate. */
export function persistedRehydratorsAll(): Iterable<() => void> {
  return persistedRehydrators;
}
