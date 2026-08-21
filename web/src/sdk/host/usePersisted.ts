import { writable, type Writable } from 'svelte/store';
import { registerPersistedRehydrate, registerPersistedReset, useStorage } from './useStorage';
import { markUnsynced } from './settingsSync';
import { assertCapability } from '../capability';

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
  /**
   * Keep this key on the phone instead of syncing it to the player's character.
   *
   * The exception, not the rule — the point of server-backed storage is that a
   * preference follows the player. `wallpaperStore` is the one that needs it: a custom
   * wallpaper is a base64 data URL of unbounded size, and syncing it would put megabytes
   * across the NUI bridge and into MySQL every time a color changed.
   *
   * Declared at the store rather than in a list inside the sync layer, because a
   * hardcoded list somewhere else is one nobody thinks to update when they add a store.
   */
  sync?: boolean;
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
  assertCapability('storage', 'usePersisted');
  const storage = useStorage(appId);
  const sanitize = options.sanitize ?? ((value: unknown) => value as T);

  if (options.sync === false) markUnsynced(appId, key);

  const readStored = () => sanitize(storage.getItem<T>(key, initial) ?? initial);
  const { subscribe, set, update } = writable<T>(readStored());

  /**
   * Back to the shipped default when the app's storage is cleared.
   *
   * Through the inner `set`, not the persisting one below — otherwise resetting would write
   * the key that clearing had just removed. The value is read once at construction, and for
   * every store in the phone that is module scope on a page CEF never unloads, so without
   * this a cleared app went on showing whatever it was holding and re-persisted it on the
   * next write.
   */
  registerPersistedReset(appId, () => set(sanitize(initial)));

  /**
   * Re-read when the server's copy arrives, or when the player loads a character.
   *
   * The value above is read **once**, at construction, which for every store in the phone
   * is module scope on a page CEF never unloads. Without this the hydrate would put the
   * right value in storage and leave the wrong one on screen for the rest of the session
   * — and switching character would show the previous character's phone.
   *
   * Through the inner `set`, like the reset above: the outer one persists, so rehydrating
   * through it would write the server's own value straight back at it.
   */
  registerPersistedRehydrate(() => set(readStored()));

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
