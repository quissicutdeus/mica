import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import type { AsTwin } from './_shared';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';
import { readKey, writeKey, removeKey, allKeys, hydrateStorage } from '../storageCache';
import {
  persistedRehydratorsAll,
  registerPersistedRehydrate,
  registerPersistedReset
} from '../../seam/persistedRegistry';

type Twin = AsTwin<ReturnType<Facets['storage']>>;

const namespaceOf = (appId: string) => `gphone:${appId}:`;

/**
 * Called by `usePersisted`'s `sync: false` (via the twin's `markUnsynced`), which cannot
 * reach `settingsSync` directly from inside a sandboxed add-on — the server-side `storage`
 * facet does that on its behalf.
 */
export function markUnsynced(appId: string, key: string): void {
  void remoteCall('storage', [appId], 'markUnsynced', key);
}

/**
 * Wire the shell's later storage pushes to the cache and every live persisted store, once
 * the transport exists. Boot only has to call `hydrateStorage` directly for the initial
 * hydrate payload; this covers every push after.
 */
let wired = false;
function wireOnStorage(): void {
  if (wired) return;
  try {
    clientTransport().onStorage((snapshot) => {
      hydrateStorage(snapshot);
      for (const rehydrate of persistedRehydratorsAll()) rehydrate();
    });
    wired = true;
  } catch {
    // Transport not set up yet — a test importing this module directly, or a facet
    // constructed before `bootAddOn()` ran. Retried on the next call that needs it.
  }
}

/** Implementation of the `useStorage` facet — see the inProcess twin for the usage contract. */
export function storage(appId: string): Twin {
  wireOnStorage();
  const getStorageKey = (key: string) => `${namespaceOf(appId)}${key}`;

  return {
    getItem: <T = unknown>(key: string, defaultValue?: T): T | null => {
      try {
        const value = readKey(getStorageKey(key));
        if (value === null) return defaultValue ?? null;
        return JSON.parse(value) as T;
      } catch {
        return defaultValue ?? null;
      }
    },
    setItem: <T = unknown>(key: string, value: T): void => {
      const encoded = JSON.stringify(value);
      writeKey(getStorageKey(key), encoded);
      void remoteCall('storage', [appId], 'setItem', key, value);
    },
    removeItem: (key: string): void => {
      removeKey(getStorageKey(key));
      void remoteCall('storage', [appId], 'removeItem', key);
    },
    markUnsynced: (key: string): void => markUnsynced(appId, key),
    /** Mirrors the inProcess twin's `clear` member — the wall-side route for `clearAppStorage`. */
    clear: () => clearAppStorage(appId)
  };
}

/** `appStorageBytes` — computed locally: the cache already holds everything it needs. */
export function appStorageBytes(appId: string): number {
  const prefix = namespaceOf(appId);
  return allKeys()
    .filter(([key]) => key.startsWith(prefix))
    .reduce((total, [key, value]) => total + key.length + value.length, 0);
}

/**
 * `clearAppStorage` is a bare function facet, not a factory — there is no member on it to
 * `remoteCall` a facet name against. It routes through the `storage` facet's own `clear`
 * member instead (see the inProcess twin's `clear` member for the wall-side half of this).
 *
 * The local cache is cleared too, and unconditionally: it was hydrated for exactly this
 * app, so sweeping every key in it is correct rather than a namespace-filtered sweep.
 */
export function clearAppStorage(appId: string): void {
  for (const [key] of allKeys()) removeKey(key);
  void remoteCall('storage', [appId], 'clear');
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('storage', storage);
registerFacet('appStorageBytes', appStorageBytes);
registerFacet('clearAppStorage', clearAppStorage);

/** See the inProcess twin: the registry is shared, only the re-export shape is per-side. */
export { registerPersistedRehydrate, registerPersistedReset };
