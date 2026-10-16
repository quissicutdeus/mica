// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PersistedOptions } from '../../../../sdk/host/facets';
import { registerFacet } from '../../../../sdk/host/current';
import { writable, type Writable } from 'svelte/store';
import { readStoredRaw, storage as storageFacet } from './storage';
import {
  holdPersistedHandle,
  type PersistedHandle,
  registerPersistedHandle
} from '../../../../sdk/host/seam/persistedRegistry';
import { markUnsynced } from '../settingsSync';

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
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
  /**
   * The stored string the value on screen was last read from or written as. Rehydrate
   * compares against it before parsing (MICA-368): every hydrate re-reads every store, and a
   * fresh `JSON.parse` hands an object store a new identity that re-fires each subscriber on
   * a character load or phone switch that changed nothing.
   */
  let lastRaw = readStoredRaw(appId, key);
  const persist = (value: T) => {
    appStorage.setItem(key, value);
    lastRaw = readStoredRaw(appId, key);
  };

  /**
   * What the registry holds, and only weakly (MICA-368): it is reached from every member of
   * the store returned below, so it is registered exactly as long as the store is reachable
   * — module scope, lazily built, or one per component mount, which is then collected after
   * the component goes. The inner writable's start notifier pins it strongly while anything
   * is subscribed, for a store reachable through nothing but its subscribers.
   * `persistedRegistry.ts` has why this is not an `onDestroy`.
   */
  const handle: PersistedHandle & { inner: Writable<T> } = {
    appId,
    inner: writable<T>(readStored(), () => holdPersistedHandle(handle)),

    /**
     * Back to the shipped default when the app's storage is cleared.
     *
     * Through the inner `set`, not the persisting one below — otherwise resetting would
     * write the key that clearing had just removed. The value is read once at construction,
     * and for every store in the phone that is module scope on a page CEF never unloads, so
     * without this a cleared app went on showing whatever it was holding and re-persisted it
     * on the next write.
     */
    reset: () => {
      lastRaw = readStoredRaw(appId, key);
      handle.inner.set(sanitize(initial));
    },

    /**
     * Re-read when the server's copy arrives, or when the player loads a character.
     *
     * The value above is read **once**, at construction, which for every store in the phone
     * is module scope on a page CEF never unloads. Without this the hydrate would put the
     * right value in storage and leave the wrong one on screen for the rest of the session
     * — and switching character would show the previous character's phone.
     *
     * Through the inner `set`, like the reset above: the outer one persists, so rehydrating
     * through it would write the server's own value straight back at it. And not at all when
     * the stored string is the one already on screen — see `lastRaw` above.
     */
    rehydrate: () => {
      const raw = readStoredRaw(appId, key);
      if (raw === lastRaw) return;
      lastRaw = raw;
      handle.inner.set(readStored());
    }
  };
  registerPersistedHandle(handle);

  // Deliberately no write here. Constructing the store must not create the key: an app
  // that only ever reads a preference should leave no trace in storage, and writing the
  // default back would also mask a later change to what that default is.
  //
  // Every member goes through `handle`, which is what keeps the registration alive — see it.
  return {
    subscribe: (run, invalidate) => handle.inner.subscribe(run, invalidate),
    set: (value: T) => {
      const next = sanitize(value);
      handle.inner.set(next);
      persist(next);
    },
    update: (fn: (current: T) => T) => {
      handle.inner.update((current) => {
        const next = sanitize(fn(current));
        persist(next);
        return next;
      });
    }
  };
}

registerFacet('persisted', persisted);
