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
 */
export function appStorageBytes(appId: string): number {
  return guarded('appStorageBytes').facets.appStorageBytes(appId);
}

/**
 * Delete everything an app has stored.
 */
export function clearAppStorage(appId: string): void {
  guarded('clearAppStorage').facets.clearAppStorage(appId);
}
