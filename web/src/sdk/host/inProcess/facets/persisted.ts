import type { PersistedOptions } from '../../facets';
import { registerFacet } from '../../current';
import { writable, type Writable } from 'svelte/store';
import { storage as storageFacet } from './storage';
import { registerPersistedRehydrate, registerPersistedReset } from '../../seam/persistedRegistry';
import { markUnsynced } from '../settingsSync';

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
export type { PersistedOptions } from '../../facets';
/** Implementation of the `usePersisted` facet — see the `usePersisted` hook doc for the usage contract. */
export function persisted<T>(
  appId: string,
  key: string,
  initial: T,
  options: PersistedOptions<T> = {}
): Writable<T> {
  const appStorage = storageFacet(appId);
  const sanitize = options.sanitize ?? ((value: unknown) => value as T);

  if (options.sync === false) markUnsynced(appId, key);

  const readStored = () => sanitize(appStorage.getItem<T>(key, initial) ?? initial);
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
      appStorage.setItem(key, next);
    },
    update: (fn: (current: T) => T) => {
      update((current) => {
        const next = sanitize(fn(current));
        appStorage.setItem(key, next);
        return next;
      });
    }
  };
}

registerFacet('persisted', persisted);
