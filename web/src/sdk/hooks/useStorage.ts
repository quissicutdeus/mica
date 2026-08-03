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
 * Delete everything an app has stored.
 *
 * Uninstalling used to drop the component and the saved bundle URL and leave the app's
 * keys behind, so reinstalling resurrected the old state — and an app removed for good
 * kept its storage for the life of the browser profile. The `gphone:<appId>:`
 * namespace was already there; nothing swept it.
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
      return;
    }
    for (const key of [...memoryStore.keys()]) {
      if (key.startsWith(prefix)) memoryStore.delete(key);
    }
  } catch (e) {
    console.error(`Failed to clear storage for ${appId}`, e);
  }
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
export function useStorage(appId: string) {
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
      try {
        const storage = getStorageBackend();
        storage.setItem(getStorageKey(key), JSON.stringify(value));
      } catch (e) {
        console.error(`Failed to set storage item for ${appId}:${key}`, e);
      }
    },
    removeItem: (key: string): void => {
      try {
        const storage = getStorageBackend();
        storage.removeItem(getStorageKey(key));
      } catch (e) {
        console.error(`Failed to remove storage item for ${appId}:${key}`, e);
      }
    }
  };
}
