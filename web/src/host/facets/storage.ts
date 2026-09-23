// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PhoneSetting } from '@mica/shared/types';
import { registerFacet } from '../../../../sdk/host/current';
import { fetchSettings } from '../../services/settings';
import {
  hasPendingWrite,
  isUnsynced,
  markUnsynced,
  pushStorageToAddOns,
  queueClearApp,
  queueRemove,
  queueWrite
} from '../settingsSync';
import {
  persistedRehydratorsAll,
  persistedResetsFor,
  registerPersistedRehydrate,
  registerPersistedReset
} from '../../../../sdk/host/seam/persistedRegistry';
import { registerSettingsHydrator } from '../../../../sdk/host/seam/settingsHydration';

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

const namespaceOf = (appId: string) => `mica:${appId}:`;

/** The literal reply `ServiceEndpoint` sends for an unauthenticated caller (`shared/…` has
 * no exported constant for it — every existing call site, client and server, matches this
 * same string literally). The CEF page hydrates at resource start, before a character is
 * selected, so this is the *expected* first answer, not a failure worth logging. */
const NOT_AUTHENTICATED = 'Player not authenticated';

/** Splits a `mica:<app>:<key>` storage key back into its two parts, or `null` for a key
 * outside this facet's namespace — `mica_first_boot_time` and friends use an underscore
 * precisely so they never match this and get swept by mistake. */
function parseSettingsKey(key: string): { app: string; setting: string } | null {
  const match = /^mica:([^:]+):(.+)$/.exec(key);
  return match ? { app: match[1], setting: match[2] } : null;
}

/** Every key in whichever backend is live, mirroring the enumeration `clearAppStorage`
 * already does below — the facet's abstracted backend has no `keys()` of its own. */
function allStorageKeys(): string[] {
  return typeof window !== 'undefined' && window.localStorage
    ? Object.keys(window.localStorage)
    : [...memoryStore.keys()];
}

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
      for (const key of memoryStore.keys()) {
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
 * Fetch this character's saved settings, or `null` on a failure that must leave the cache
 * untouched — including the "Player not authenticated" reply the CEF page gets at every
 * boot before a character is selected, which is expected and not worth a console line.
 * Shared by both hydrates below; `context` only decorates the one message that isn't that
 * expected case.
 */
async function fetchRowsOrNull(context: string): Promise<PhoneSetting[] | null> {
  try {
    return await fetchSettings();
  } catch (error) {
    const expected = error instanceof Error && error.message === NOT_AUTHENTICATED;
    if (!expected) {
      console.error(
        `[settings] ${context} failed; keeping the values already on the phone.`,
        error
      );
    }
    return null;
  }
}

/**
 * Copy this character's saved settings into the cache, additively, and re-read every live
 * store. Runs at page load — installed as the sdk seam's `hydrateSettings()` below — and
 * never removes a key.
 *
 * MICA-287 round 3: this function used to also sweep whatever the answer omitted, which is
 * wrong here specifically. It runs before any character is guaranteed to exist, and the
 * dev/e2e mock transport's `settings:getAll` starts empty and resolves `[]` on every page
 * load with no concept of "not authenticated" to reject on at all — so a sweeping policy in
 * this function deleted every seeded `mica:*` key on first paint in `pnpm dev`, the demo
 * container and most of the e2e suite. The sweep now lives only in
 * `hydrateSettingsOnCharacterLoad` below, reached from an actual character-load signal
 * rather than from every page load.
 */
async function hydrateSettingsInProcess(): Promise<void> {
  const rows = await fetchRowsOrNull('Hydration');
  if (rows === null) return;

  try {
    const backend = getStorageBackend();
    for (const row of rows) {
      if (!row?.app || !row?.setting_key) continue;
      if (isUnsynced(row.app, row.setting_key)) continue;
      backend.setItem(`${namespaceOf(row.app)}${row.setting_key}`, row.setting_value ?? 'null');
    }
    for (const rehydrate of persistedRehydratorsAll()) rehydrate();
  } catch (error) {
    // The fetch itself succeeded — this is a local failure (a full backend, a rehydrate
    // callback throwing) part way through applying it, so it gets its own message rather
    // than the one `fetchRowsOrNull` logs, which is specifically about the fetch itself.
    console.error('[settings] Hydration failed partway through; some values may be stale.', error);
  }
}

/**
 * The authoritative, sweeping hydrate: clears whatever this character has no row for,
 * writes what it does, re-reads every live store, and pushes a fresh snapshot to every
 * live add-on frame.
 *
 * MICA-287 round 3: deliberately *not* reachable through the sdk seam's `hydrateSettings()`
 * — see `hydrateSettingsInProcess` above for why the page-load path must stay additive.
 * `web/src/shell/nuiMessages.ts` calls this directly, from the `rehydrateSettings` route
 * and from `rehydrateShell`. Both are real character-load signals from the server: a phone
 * switch (`server/lib/phoneItem.ts`) sends only `rehydrateShell`, and settings are stored
 * per phone id, so it needs the sweep too, or the previous phone's values stay on screen.
 * A double run of either is harmless — this function is idempotent against the server's
 * current answer and cancels no writes (see the pending-write check below), so two firings
 * for one character load (qbx sends both `QBCore:Server:OnPlayerLoaded` events) just apply
 * the same answer twice.
 *
 * A key with a write still queued in `settingsSync.ts`'s debounce is skipped by both the
 * sweep and the write below: the local value behind that write is newer than whatever
 * answer just arrived, since the debounce has simply not flushed it to the server yet.
 * Cancelling that write instead (this ticket's first attempt, via `cancelAllPendingWrites`)
 * silently dropped a real, just-made edit on exactly the double-run case above.
 */
export async function hydrateSettingsOnCharacterLoad(): Promise<void> {
  const rows = await fetchRowsOrNull('Character-load hydration');
  if (rows === null) return;

  try {
    const backend = getStorageBackend();
    const provided = new Set<string>();
    for (const row of rows) {
      if (!row?.app || !row?.setting_key) continue;
      provided.add(`${row.app}:${row.setting_key}`);
    }

    // Anything cached under this namespace that the answer above did not mention belongs
    // to whoever was loaded before — a character switch, not a partial save. Unsynced
    // keys are excluded: they never had a server row to lose in the first place
    // (`settingsSync.ts`), and they are meant to survive on the device regardless of who
    // is logged in, so their absence from `provided` says nothing about this character.
    // A synced value the server refused (too long, wrong shape) never had a row either, so
    // it is swept the same way — accepted, since the server is the source of truth here.
    for (const key of allStorageKeys()) {
      const parsed = parseSettingsKey(key);
      if (!parsed) continue;
      if (isUnsynced(parsed.app, parsed.setting)) continue;
      if (hasPendingWrite(parsed.app, parsed.setting)) continue;
      if (!provided.has(`${parsed.app}:${parsed.setting}`)) backend.removeItem(key);
    }

    for (const row of rows) {
      if (!row?.app || !row?.setting_key) continue;
      if (isUnsynced(row.app, row.setting_key)) continue;
      if (hasPendingWrite(row.app, row.setting_key)) continue;
      backend.setItem(`${namespaceOf(row.app)}${row.setting_key}`, row.setting_value ?? 'null');
    }

    for (const rehydrate of persistedRehydratorsAll()) rehydrate();

    // A live add-on frame keeps its own copy of this same local state (MICA-287) — the
    // sweep and write above never touch it, since it lives on the other side of the wall.
    // Pushed last, after this side is already correct, so a frame that reads its snapshot
    // the moment it arrives never sees a half-applied hydrate.
    pushStorageToAddOns();
  } catch (error) {
    console.error(
      '[settings] Character-load hydration failed partway through; some values may be stale.',
      error
    );
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
