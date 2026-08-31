import { registerFacet } from '../../sdk/host/current';
import { fetchSettings } from '../../services/settings';
import { isUnsynced, markUnsynced, queueClearApp, queueRemove, queueWrite } from '../settingsSync';
import {
  persistedRehydratorsAll,
  persistedResetsFor,
  registerPersistedRehydrate,
  registerPersistedReset
} from '../../sdk/host/seam/persistedRegistry';
import { registerSettingsHydrator } from '../../sdk/host/seam/settingsHydration';

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
  for (const reset of persistedResetsFor(appId)) reset();
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
async function hydrateSettingsInProcess(): Promise<void> {
  try {
    const rows = await fetchSettings();
    const backend = getStorageBackend();

    for (const row of rows) {
      if (!row?.app || !row?.setting_key) continue;
      if (isUnsynced(row.app, row.setting_key)) continue;
      backend.setItem(`${namespaceOf(row.app)}${row.setting_key}`, row.setting_value ?? 'null');
    }

    for (const rehydrate of persistedRehydratorsAll()) rehydrate();
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
    },
    /**
     * Serves the iframe `persisted` twin's `markUnsynced` (MICA-16 step 4): an add-on
     * cannot import `settingsSync` directly, so this is the one member of the facet that
     * reaches it on the add-on's behalf.
     */
    markUnsynced: (key: string): void => markUnsynced(appId, key),
    /**
     * The wall-side route for `clearAppStorage` (MICA-16 step 4): that facet is a bare
     * function, not a factory, so a `remoteCall` naming it has no member to call. This
     * member is what the iframe twin's `clearAppStorage(appId)` actually reaches.
     */
    clear: () => clearAppStorage(appId)
  };
}

registerFacet('storage', storage);

registerFacet('appStorageBytes', appStorageBytes);

registerFacet('clearAppStorage', clearAppStorage);

/**
 * MICA-176: the in-process half of `hydrateSettings`, installed rather than exported.
 * `useStorage.ts` re-exports the neutral `hydrateSettings` from `seam/settingsHydration`,
 * which is a no-op until this line runs — and this module is on the graph only through
 * `inProcess/registerFacets.ts`, which only the shell's entry point imports.
 */
registerSettingsHydrator(hydrateSettingsInProcess);

/**
 * Re-exported so `registerPersistedReset`/`registerPersistedRehydrate` keep the shape
 * `persisted.ts` imports them in, on both sides. The registry itself is shared —
 * `seam/persistedRegistry.ts` — because the bookkeeping never had a side.
 */
export { registerPersistedRehydrate, registerPersistedReset };
