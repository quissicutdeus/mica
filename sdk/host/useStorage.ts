// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
/**
 * MICA-176. These three used to be re-exported from `./inProcess/facets/storage`, and
 * `facetSwap()` in `vite.addon.config.ts` rewrote that specifier to the iframe twin for an
 * add-on build — a value edge across the seam that only a resolver plugin was keeping
 * honest. Both files below are side-free by construction, so there is nothing left to
 * choose: the persisted-store registry is shared (the bookkeeping never had a side), and
 * `hydrateSettings` is a no-op until `inProcess/facets/storage.ts` installs the real one,
 * which happens only in a bundle that loaded the in-process facet set.
 */
export { registerPersistedReset, registerPersistedRehydrate } from './seam/persistedRegistry';
export { hydrateSettings } from './seam/settingsHydration';

/**
 * OS Service Hook for app key-value storage.
 */
export function useStorage(appId: string) {
  return guarded('useStorage', appId).facets.storage(appId);
}

/**
 * How many bytes an app has actually stored.
 *
 * The Store used to show a made-up number here — `(id.length + name.length +
 * permissions.length) * 85`, which meant declaring one more permission grew the app's
 * reported footprint. Everything an app writes is under `gos:<appId>:` already, so the
 * real answer is a sum away.
 *
 * Keys are counted alongside values: both occupy the quota, and an app storing many tiny
 * entries is not free.
 */
export function appStorageBytes(appId: string): number {
  return guarded('appStorageBytes').facets.appStorageBytes(appId);
}

/**
 * Delete everything an app has stored.
 *
 * Uninstalling used to drop the component and the saved bundle URL and leave the app's
 * keys behind, so reinstalling resurrected the old state — and an app removed for good
 * kept its storage for the life of the browser profile. The `gos:<appId>:`
 * namespace was already there; nothing swept it.
 *
 * Live persisted stores are reset alongside the keys, so a `usePersisted` value in memory
 * does not go on showing the old data and write it straight back on its next change.
 */
export function clearAppStorage(appId: string): void {
  guarded('clearAppStorage').facets.clearAppStorage(appId);
}
