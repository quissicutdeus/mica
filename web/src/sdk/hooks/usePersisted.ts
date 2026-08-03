import { writable, type Writable } from 'svelte/store';
import { useStorage } from './useStorage';

export interface PersistedOptions<T> {
  /**
   * Repair or reject a value before it is stored or handed out.
   *
   * Runs on the value read at startup *and* on every write, so a store cannot be talked
   * into holding something the app would refuse. Stored data outlives the code that
   * wrote it: a key whose shape changed between versions, or one a player edited by
   * hand, comes back as whatever it was. `volumeStep` has needed this from the start.
   */
  sanitize?: (value: unknown) => T;
}

/**
 * A writable store that survives a reload.
 *
 * `useStorage` is imperative — `getItem`/`setItem` — so every preference, draft and high
 * score was the same hand-written pair: read once at init, write on every change. The
 * shell had already written it by hand for `volumeStep`, sanitizer and all, which is the
 * signal that it belongs in the SDK rather than in each app.
 *
 * Reads are namespaced per app by `useStorage`, so two apps may use the same key.
 *
 * ```ts
 * const highScore = usePersisted('snake', 'highScore', 0);
 * $highScore = Math.max($highScore, score);
 * ```
 */
export function usePersisted<T>(
  appId: string,
  key: string,
  initial: T,
  options: PersistedOptions<T> = {}
): Writable<T> {
  const storage = useStorage(appId);
  const sanitize = options.sanitize ?? ((value: unknown) => value as T);

  const stored = storage.getItem<T>(key, initial);
  const { subscribe, set, update } = writable<T>(sanitize(stored ?? initial));

  // Deliberately no write here. Constructing the store must not create the key: an app
  // that only ever reads a preference should leave no trace in storage, and writing the
  // default back would also mask a later change to what that default is.
  return {
    subscribe,
    set: (value: T) => {
      const next = sanitize(value);
      set(next);
      storage.setItem(key, next);
    },
    update: (fn: (current: T) => T) => {
      update((current) => {
        const next = sanitize(fn(current));
        storage.setItem(key, next);
        return next;
      });
    }
  };
}
