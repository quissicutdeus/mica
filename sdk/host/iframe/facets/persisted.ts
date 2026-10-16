// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PersistedOptions } from '../../facets';
import { registerFacet } from '../../current';
import { writable, type Writable } from 'svelte/store';
import { readStoredRaw, storage as storageFacet, markUnsynced } from './storage';
import {
  holdPersistedHandle,
  registerPersistedHandle,
  type PersistedHandle
} from '../../seam/persistedRegistry';

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
export type { PersistedOptions } from '../../facets';
/** Implementation of the `usePersisted` facet — the inProcess twin carries the reasoning. */
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
  // MICA-368, as in the inProcess twin: registered weakly through a handle every member
  // holds, pinned while subscribed, and rehydrate skips a stored string already on screen.
  let lastRaw = readStoredRaw(appId, key);
  const persist = (value: T) => {
    appStorage.setItem(key, value);
    lastRaw = readStoredRaw(appId, key);
  };

  const handle: PersistedHandle & { inner: Writable<T> } = {
    appId,
    inner: writable<T>(readStored(), () => holdPersistedHandle(handle)),
    reset: () => {
      lastRaw = readStoredRaw(appId, key);
      handle.inner.set(sanitize(initial));
    },
    rehydrate: () => {
      const raw = readStoredRaw(appId, key);
      if (raw === lastRaw) return;
      lastRaw = raw;
      handle.inner.set(readStored());
    }
  };
  registerPersistedHandle(handle);

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
