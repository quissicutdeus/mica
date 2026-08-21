import { registerFacet } from '../../current';
import { fetchSettings } from '../../../../services/settings';
import { isUnsynced, queueClearApp, queueRemove, queueWrite } from '../settingsSync';

const memoryStore = new Map<string, string>();

function getStorageBackend() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => memoryStore.set(key, value),
    removeItem: (key: string) => memoryStore.delete(key)
  };
}

const namespaceOf = (appId: string) => `gphone:${appId}:`;

/**
 * Live `usePersisted` stores, per app, so clearing storage resets them too.
 *
 * Sweeping the keys is not enough on its own, and the gap is not theoretical. A persisted
 * store reads its key **once**, at construction — which for every one of them is module
 * scope, and the CEF page never unloads. So clearing an app's storage while its store is in
 * memory left the old value on screen, and the store's next write put the key straight back.
 * "Back to a freshly installed state" would have been true only of the keys nothing was
 * holding.
 *
 * A registry rather than an event because the reset has to reach the *inner* writable:
 * `usePersisted`'s own `set` persists, so resetting through it would recreate the key it was
 * just asked to delete.
 */
const persistedResets = new Map<string, Set<() => void>>();

/**
 * Internal, for `usePersisted`. Not something an app has a reason to call.
 *
 * Stores are never disposed — they live in module scope for the life of the page — so there is
 * nothing to unregister and no leak in keeping them.
 */
export function registerPersistedReset(appId: string, reset: () => void): void {
  const existing = persistedResets.get(appId);
  if (existing) existing.add(reset);
  else persistedResets.set(appId, new Set([reset]));
}

/**
 * Live stores that can re-read their key, for hydration.
 *
 * Deliberately **not** `persistedResets`, which sets a store back to its shipped default.
 * That is the right answer for "this app's storage was cleared" and the wrong one for
 * "the server just told us what this character had": reusing it would reset every
 * preference to the default at the exact moment the real values arrived.
 */
const persistedRehydrators = new Set<() => void>();

/** Internal, for `usePersisted`. Stores live for the life of the page, so nothing unregisters. */
export function registerPersistedRehydrate(rehydrate: () => void): void {
  persistedRehydrators.add(rehydrate);
}

/**
 * Implementation of the `clearAppStorage` facet — see the `clearAppStorage` hook doc for
 * the usage contract.
 *
 * Live persisted stores are reset alongside the keys — see `persistedResets` above for why
 * the sweep alone leaves the app looking untouched.
 */
export function clearAppStorage(appId: string): void {
  const prefix = namespaceOf(appId);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      // Snapshot the keys before removing any. Walking localStorage by index while
      // deleting from it renumbers the entries and skips every other match.
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith(prefix)) window.localStorage.removeItem(key);
      }
    } else {
      for (const key of [...memoryStore.keys()]) {
        if (key.startsWith(prefix)) memoryStore.delete(key);
      }
    }
  } catch (e) {
    console.error(`Failed to clear storage for ${appId}`, e);
  }

  // The server copy too, or the rows outlive the uninstall and come back on the next
  // hydrate — the same resurrection this function's comment above exists to prevent, one
  // layer down.
  queueClearApp(appId);

  // Outside the try, and after the sweep: a storage backend that threw must not leave the
  // stores holding values whose keys may already be gone.
  for (const reset of persistedResets.get(appId) ?? []) reset();
}

/**
 * Copy this character's saved settings into the cache and re-read every live store.
 *
 * Runs at page load and again on every character load. The CEF page never unloads, so
 * switching character without a resource restart would otherwise leave the previous
 * character's phone on screen — which is the bug this whole change exists to fix, not a
 * corner case.
 *
 * Live stores are reset through the same `persistedResets` registry `clearAppStorage`
 * uses. They read their key once, at construction, so writing the cache alone would put
 * the right value in storage and leave the wrong one on screen.
 *
 * A failed fetch leaves the cache untouched. Keeping whatever the phone was already
 * showing beats resetting a working phone to defaults because one request timed out.
 */
export async function hydrateSettings(): Promise<void> {
  try {
    const rows = await fetchSettings();
    const backend = getStorageBackend();

    for (const row of rows) {
      if (!row?.app || !row?.setting_key) continue;
      if (isUnsynced(row.app, row.setting_key)) continue;
      backend.setItem(`${namespaceOf(row.app)}${row.setting_key}`, row.setting_value ?? 'null');
    }

    for (const rehydrate of persistedRehydrators) rehydrate();
  } catch (error) {
    console.error('[settings] Hydration failed; keeping the values already on the phone.', error);
  }
}

/**
 * Implementation of the `appStorageBytes` facet — see the `appStorageBytes` hook doc for
 * the usage contract. Keys are counted alongside values here: both occupy the quota.
 */
export function appStorageBytes(appId: string): number {
  const prefix = namespaceOf(appId);
  try {
    const entries =
      typeof window !== 'undefined' && window.localStorage
        ? Object.keys(window.localStorage).map(
            (key) => [key, window.localStorage.getItem(key) ?? ''] as const
          )
        : [...memoryStore.entries()];

    return entries
      .filter(([key]) => key.startsWith(prefix))
      .reduce((total, [key, value]) => total + key.length + value.length, 0);
  } catch {
    return 0;
  }
}

/**
 * OS Service Hook for app key-value storage.
 */
export function storage(appId: string) {
  const getStorageKey = (key: string) => `${namespaceOf(appId)}${key}`;

  return {
    getItem: <T = unknown>(key: string, defaultValue?: T): T | null => {
      try {
        const storage = getStorageBackend();
        const value = storage.getItem(getStorageKey(key));
        if (value === null) return defaultValue ?? null;
        return JSON.parse(value) as T;
      } catch {
        return defaultValue ?? null;
      }
    },
    setItem: <T = unknown>(key: string, value: T): void => {
      const encoded = JSON.stringify(value);
      try {
        const storage = getStorageBackend();
        storage.setItem(getStorageKey(key), encoded);
      } catch (e) {
        console.error(`Failed to set storage item for ${appId}:${key}`, e);
      }
      // After the local write and outside its try: the cache is what the phone reads, so
      // it must land even if the server never hears about it. Debounced per key, so
      // dragging a slider is one request rather than one per frame.
      queueWrite(appId, key, encoded);
    },
    removeItem: (key: string): void => {
      try {
        const storage = getStorageBackend();
        storage.removeItem(getStorageKey(key));
      } catch (e) {
        console.error(`Failed to remove storage item for ${appId}:${key}`, e);
      }
      queueRemove(appId, key);
    }
  };
}

registerFacet('storage', storage);

registerFacet('appStorageBytes', appStorageBytes);

registerFacet('clearAppStorage', clearAppStorage);
