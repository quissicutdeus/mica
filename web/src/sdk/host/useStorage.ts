import './inProcess/facets/storage';
import { guarded } from './guard';
export {
  registerPersistedReset,
  registerPersistedRehydrate,
  hydrateSettings
} from './inProcess/facets/storage';

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
 * reported footprint. Everything an app writes is under `gphone:<appId>:` already, so the
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
 * kept its storage for the life of the browser profile. The `gphone:<appId>:`
 * namespace was already there; nothing swept it.
 *
 * Live persisted stores are reset alongside the keys, so a `usePersisted` value in memory
 * does not go on showing the old data and write it straight back on its next change.
 */
export function clearAppStorage(appId: string): void {
  guarded('clearAppStorage').facets.clearAppStorage(appId);
}
