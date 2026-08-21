import { saveSetting, removeSetting, clearAppSettings } from '../../../services/settings';

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
 * Internal. Not exported from `@gphone/sdk`: an app reaches this through `useStorage`, and
 * a hook that let an add-on force a hydrate is a way to stamp on another app's namespace.
 */

/** Writes still in flight, per `<app>:<key>`, so a slider drag is one request. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Namespaces whose writes never leave the phone.
 *
 * A wallpaper **image** is a base64 data URL of unbounded size, and syncing it would put
 * megabytes across the NUI bridge and into MySQL every time a color changed. Registered by
 * `usePersisted`'s `sync: false`, so the exception is declared at the store that needs it
 * rather than hardcoded in a list here that nobody would think to update.
 */
const unsynced = new Set<string>();

const compositeOf = (app: string, key: string) => `${app}:${key}`;

/** Called by `usePersisted` for a store that opts out. */
export function markUnsynced(app: string, key: string): void {
  unsynced.add(compositeOf(app, key));
}

/** Test seam: module state that would otherwise leak between cases. */
export function __resetSettingsSync(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  unsynced.clear();
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
