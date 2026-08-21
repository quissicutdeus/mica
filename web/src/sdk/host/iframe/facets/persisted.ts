import { registerFacet } from '../../current';
import { writable, type Writable } from 'svelte/store';
import {
  storage as storageFacet,
  registerPersistedRehydrate,
  registerPersistedReset,
  markUnsynced
} from './storage';

export interface PersistedOptions<T> {
  sanitize?: (value: unknown) => T;
  sync?: boolean;
}

/** Implementation of the `usePersisted` facet — copied verbatim from the inProcess twin. */
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

  registerPersistedReset(appId, () => set(sanitize(initial)));
  registerPersistedRehydrate(() => set(readStored()));

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
