import { registerFacet } from '../../current';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';
import { readKey, writeKey, removeKey, allKeys, hydrateStorage } from '../storageCache';

type Twin = ReturnType<typeof import('../../inProcess/facets/storage').storage>;

const namespaceOf = (appId: string) => `gphone:${appId}:`;

/**
 * Live `usePersisted` stores, per app — mirrors the inProcess registry so `persisted.ts`
 * can reset/rehydrate them the same way. See the inProcess `storage.ts` for why a registry
 * rather than an event: the reset has to reach the *inner* writable.
 */
const persistedResets = new Map<string, Set<() => void>>();

/** Internal, for the `persisted` twin. */
export function registerPersistedReset(appId: string, reset: () => void): void {
  const existing = persistedResets.get(appId);
  if (existing) existing.add(reset);
  else persistedResets.set(appId, new Set([reset]));
}

/** Live stores that can re-read their key, for rehydration. See inProcess `storage.ts`. */
const persistedRehydrators = new Set<() => void>();

/** Internal, for the `persisted` twin. */
export function registerPersistedRehydrate(rehydrate: () => void): void {
  persistedRehydrators.add(rehydrate);
}

/**
 * Called by `usePersisted`'s `sync: false` (via the twin's `markUnsynced`), which cannot
 * reach `settingsSync` directly from inside a sandboxed add-on — the server-side `storage`
 * facet does that on its behalf.
 */
export function markUnsynced(appId: string, key: string): void {
  void remoteCall('storage', [appId], 'markUnsynced', key);
}

/**
 * The inProcess twin hydrates settings from the real DB once at shell boot; an add-on's
 * storage arrives synchronously in the frame's `hydrate` message instead (see
 * `storageCache.ts`), so there is nothing for this to do here. It exists only because
 * `useStorage.ts` re-exports it unconditionally from whichever `storage` twin the build
 * resolves to, and the module graph needs the export to exist either way.
 */
export async function hydrateSettings(): Promise<void> {}

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
      for (const rehydrate of persistedRehydrators) rehydrate();
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
  } as unknown as Twin;
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

registerFacet('storage', storage);
registerFacet('appStorageBytes', appStorageBytes);
registerFacet('clearAppStorage', clearAppStorage);
