// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * `usePersisted` registers **weakly** (MICA-368). It is a hook, so one called inside a
 * component — an add-on's high score, read in its root component — built a fresh store per
 * mount, and a strong registration kept every one of them, and its two closures, for the
 * life of the page. Unregistering in `onDestroy` was the first attempt and the wrong one: a
 * store built lazily *during* a component's init but kept at module scope would be dropped
 * when that component died while the store lived on — and a store that has stopped
 * rehydrating shows the previous character's value after a switch, which is worse than the
 * leak. So the registry holds a `WeakRef` to the store's handle instead, and the store's own
 * members hold the handle: the registration lives exactly as long as anything can still
 * reach the store, however and wherever it was built.
 *
 * One more holder than that, because a store can be reachable through nothing but its own
 * subscribers: `usePersisted(…).subscribe(apply)` at module scope keeps no reference to the
 * store and still needs every rehydrate. While a store has at least one subscriber it is
 * pinned strongly (`holdPersistedHandle`, wired as the inner writable's start/stop), and
 * only an unsubscribed, unreachable store is ever collected.
 *
 * `registerPersistedReset` and `registerPersistedRehydrate` stay strong, as they always
 * were — they take a bare callback, and a weakly held inline closure would be collected
 * before its first call. They are on the add-on surface, so they keep that meaning and now
 * also return an unregister, for a caller that wants to clean up after itself.
 */

/** What `usePersisted` registers: one store's two answers. Held weakly; see above. */
export interface PersistedHandle {
  readonly appId: string;
  /** Back to the shipped default — `clearAppStorage`. */
  reset(): void;
  /** Re-read the key from the backend — a settings hydrate. */
  rehydrate(): void;
}

const persistedResets = new Map<string, Set<() => void>>();
const persistedRehydrators = new Set<() => void>();
const weakHandles = new Set<WeakRef<PersistedHandle>>();
const heldHandles = new Set<PersistedHandle>();

/** Drop every weak entry whose store has been collected. */
function pruneHandles(): void {
  for (const ref of weakHandles) if (!ref.deref()) weakHandles.delete(ref);
}

/**
 * Every handle whose store is still reachable, pruning as it goes.
 *
 * Pruned on read and on register rather than by a `FinalizationRegistry`: every reader walks
 * the set anyway, so it never holds more dead entries than were collected since the last
 * store was built or the last hydrate or clear ran.
 */
function* liveHandles(): Generator<PersistedHandle> {
  for (const ref of weakHandles) {
    const handle = ref.deref();
    if (handle) yield handle;
    else weakHandles.delete(ref);
  }
}

/**
 * Internal, for `usePersisted`: register one store, weakly. The caller keeps `handle`
 * reachable from every member of the store it returns — that reachability *is* the
 * registration — and wires `holdPersistedHandle` as the inner writable's start notifier.
 */
export function registerPersistedHandle(handle: PersistedHandle): void {
  pruneHandles();
  weakHandles.add(new WeakRef(handle));
}

/**
 * Internal, for `usePersisted`: pin a store strongly while it has a subscriber, as the inner
 * writable's start notifier. Svelte calls start on the first subscriber and the returned stop
 * after the last, so the pin needs no count of its own.
 */
export function holdPersistedHandle(handle: PersistedHandle): () => void {
  heldHandles.add(handle);
  return () => {
    heldHandles.delete(handle);
  };
}

/**
 * Register a reset for one app's storage being cleared. Held strongly, for the life of the
 * page or until the returned unregister is called; calling that twice is harmless, and the
 * app's entry goes once its last reset does.
 */
export function registerPersistedReset(appId: string, reset: () => void): () => void {
  const existing = persistedResets.get(appId);
  if (existing) existing.add(reset);
  else persistedResets.set(appId, new Set([reset]));
  return () => {
    const resets = persistedResets.get(appId);
    if (!resets) return;
    resets.delete(reset);
    if (resets.size === 0) persistedResets.delete(appId);
  };
}

/** Register a rehydrate, held strongly; the returned unregister is harmless to call twice. */
export function registerPersistedRehydrate(rehydrate: () => void): () => void {
  persistedRehydrators.add(rehydrate);
  return () => {
    persistedRehydrators.delete(rehydrate);
  };
}

/** Every reset for one app, strong and live weak alike. Used by `clearAppStorage` on both sides. */
export function* persistedResetsFor(appId: string): Generator<() => void> {
  yield* persistedResets.get(appId) ?? [];
  for (const handle of liveHandles()) {
    if (handle.appId === appId) yield () => handle.reset();
  }
}

/** Every rehydrate in this context, strong and live weak alike. Used by both settings hydrates. */
export function* persistedRehydratorsAll(): Generator<() => void> {
  yield* persistedRehydrators;
  for (const handle of liveHandles()) yield () => handle.rehydrate();
}
