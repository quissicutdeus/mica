// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { saveSetting, removeSetting, clearAppSettings } from '../services/settings';

/**
 * Server-backed storage, without making `useStorage` async.
 *
 * `useStorage.getItem` is synchronous and `usePersisted` calls it **once**, at module
 * construction — and every store in the phone is module scope on a page CEF never unloads.
 * So the API cannot become a promise without rewriting every call site and `usePersisted`
 * with it.
 *
 * The way out is that `localStorage` stops being the authority and becomes a **cache**.
 * Reads stay synchronous against it; the server row is the truth, copied in at boot and
 * written back in the background. Nothing at any call site changes, which is the whole
 * reason every namespace could move at once rather than only `settings`.
 *
 * Internal. Not exported from `@mica/sdk`: an app reaches this through `useStorage`, and
 * a hook that let an add-on force a hydrate is a way to stamp on another app's namespace.
 */

/** Writes still in flight, per `<app>:<key>`, so a slider drag is one request. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The device-persisted record of which `<app>:<key>` pairs are unsynced, under an
 * underscore key so it sits outside the `mica:<app>:<key>` shape the character-load sweep
 * in `host/facets/storage.ts` walks (`parseSettingsKey` there only matches a colon after
 * `mica`) — the record must never itself be swept.
 *
 * MICA-287 round 3: an add-on marks its own `sync: false` keys unsynced only when its
 * frame boots, over a `remoteCall` from `sdk/host/iframe/facets/persisted.ts` — and an
 * add-on is opened on demand, not necessarily before the next character-load sweep. A
 * closed add-on's key would otherwise look, to that sweep, exactly like a key the new
 * character has no row for and never had a chance to opt out of. Persisting the mark on
 * the device (not per character — a `sync: false` store is a device preference, same as
 * the values it protects) means the record survives independently of whether *this*
 * session ever reopens that add-on.
 */
const UNSYNCED_STORAGE_KEY = 'mica_unsynced_settings';

/** In-memory fallback for the record above, mirroring `host/facets/storage.ts`'s own —
 * this module cannot import that one's backend without a cycle (`storage.ts` already
 * imports this module). */
let memoryUnsyncedFallback: string | null = null;

function readPersistedUnsynced(): string | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem(UNSYNCED_STORAGE_KEY);
  }
  return memoryUnsyncedFallback;
}

function writePersistedUnsynced(raw: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(UNSYNCED_STORAGE_KEY, raw);
  } else {
    memoryUnsyncedFallback = raw;
  }
}

function loadPersistedUnsynced(): Set<string> {
  try {
    const raw = readPersistedUnsynced();
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistUnsynced(): void {
  try {
    writePersistedUnsynced(JSON.stringify([...unsynced]));
  } catch {
    // Best effort — a full or blocked store just means this device re-learns the set as
    // each `sync: false` store boots again this session, same as before this existed.
  }
}

/**
 * Namespaces whose writes never leave the phone.
 *
 * A wallpaper **image** is a base64 data URL of unbounded size, and syncing it would put
 * megabytes across the NUI bridge and into MySQL every time a color changed. Registered by
 * `usePersisted`'s `sync: false`, so the exception is declared at the store that needs it
 * rather than hardcoded in a list here that nobody would think to update. Seeded from the
 * device record above at module load, then kept in sync with it by every `markUnsynced`.
 */
const unsynced = loadPersistedUnsynced();

const compositeOf = (app: string, key: string) => `${app}:${key}`;

/** Called by `usePersisted` for a store that opts out. */
export function markUnsynced(app: string, key: string): void {
  unsynced.add(compositeOf(app, key));
  persistUnsynced();
}

/**
 * Whether `<app>:<key>` has a write still waiting out its debounce.
 *
 * MICA-287 round 3: the character-load hydrate consults this before sweeping *or*
 * overwriting a key. The local value behind a pending write is newer than whatever answer
 * the hydrate just fetched — the debounce simply hasn't flushed it to the server yet — so
 * neither clearing it nor overwriting it with the fetched value is correct. Cancelling the
 * write instead (this ticket's first attempt) dropped a real edit whenever the game fired
 * the hydrate twice for one character load, which qbx does.
 */
export function hasPendingWrite(app: string, key: string): boolean {
  return pending.has(compositeOf(app, key));
}

/** Test seam: module state that would otherwise leak between cases. */
export function __resetSettingsSync(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  unsynced.clear();
  persistUnsynced();
  addOnStoragePushes.clear();
}

/**
 * How long a write waits for another on the same key.
 *
 * Dragging the display-size slider fires a write per frame. Debouncing per key rather
 * than globally means a slider drag cannot delay an unrelated toggle the player flipped
 * in the same second.
 */
const WRITE_DEBOUNCE_MS = 400;

export function queueWrite(app: string, key: string, value: string): void {
  const composite = compositeOf(app, key);
  if (unsynced.has(composite)) return;

  const existing = pending.get(composite);
  if (existing) clearTimeout(existing);

  pending.set(
    composite,
    setTimeout(() => {
      pending.delete(composite);
      void saveSetting(app, key, value);
    }, WRITE_DEBOUNCE_MS)
  );
}

export function queueRemove(app: string, key: string): void {
  const composite = compositeOf(app, key);
  if (unsynced.has(composite)) return;

  const existing = pending.get(composite);
  if (existing) {
    clearTimeout(existing);
    pending.delete(composite);
  }
  void removeSetting(app, key);
}

/** Drop a whole namespace server-side, so an uninstalled app does not come back on hydrate. */
export function queueClearApp(app: string): void {
  for (const [composite, timer] of pending.entries()) {
    if (composite.startsWith(`${app}:`)) {
      clearTimeout(timer);
      pending.delete(composite);
    }
  }
  void clearAppSettings(app);
}

/**
 * Whether a key opted out, for the hydrate in `useStorage`.
 *
 * `hydrateSettings` lives there rather than here because that module already owns the
 * cache and the reset registry. Importing them into this one would make the pair
 * circular, and a cycle between two modules that both run work at import time is a class
 * of bug worth not having.
 */
export const isUnsynced = (app: string, key: string): boolean =>
  unsynced.has(compositeOf(app, key));

/**
 * Live add-on frames that want a fresh storage snapshot pushed to them once a character
 * switch's hydrate lands — MICA-287's second half.
 *
 * `sdk/host/seam/persistedRegistry.ts`'s `persistedRehydratorsAll` exists for exactly this
 * shape of problem — "run this after every hydrate" — but is deliberately unregisterable:
 * every one of its callbacks belongs to a `usePersisted` store, one per key, alive for the
 * life of the page, so there is nothing to remove and no leak in keeping them all. An
 * add-on frame is not that: it is resident once opened, like an in-process app, but its
 * `IframeHostServer` is disposed and rebuilt on every Restart and on uninstall, and a
 * callback with no way to leave a shared, permanent registry would grow one stale entry
 * per restart for the life of the session. This registry is a plain `Set`, deliberately
 * separate from the sdk one, precisely so `IframeHostServer.ts` can hand back an
 * unregister function and actually use it.
 */
const addOnStoragePushes = new Set<() => void>();

/**
 * Called by `IframeHostServer` once its guest has a live `hello` answered — mirrors how it
 * starts the theme push, and for the same reason: nothing is listening before that, and
 * the initial snapshot already went out in the hydrate payload itself.
 */
export function registerAddOnStoragePush(push: () => void): () => void {
  addOnStoragePushes.add(push);
  return () => addOnStoragePushes.delete(push);
}

/**
 * Called by the character-load hydrate (`host/facets/storage.ts`'s
 * `hydrateSettingsOnCharacterLoad`) after a successful, already-applied answer — never by
 * the page-load hydrate, which never sweeps, and never on a failure: a live add-on frame's
 * cache is a second copy of the same local state, and it must not be told to clear itself
 * off a request that never actually landed.
 */
export function pushStorageToAddOns(): void {
  for (const push of addOnStoragePushes) push();
}
