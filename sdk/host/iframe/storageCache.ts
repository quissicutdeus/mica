// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// MICA-16 step 4: the iframe's storage cache — reads are synchronous against what the
// shell handed over at hydrate (and refreshed on every `storage` push after), never a
// round trip. This is what lets `usePersisted`/`useStorage` stay sync inside an add-on.

let cache = new Map<string, string>();

/** Replace the whole cache with the shell's snapshot — the initial hydrate, or a later push. */
export function hydrateStorage(snapshot: Record<string, string>): void {
  cache = new Map(Object.entries(snapshot));
}

export function readKey(key: string): string | null {
  return cache.get(key) ?? null;
}

export function writeKey(key: string, raw: string): void {
  cache.set(key, raw);
}

export function removeKey(key: string): void {
  cache.delete(key);
}

export function allKeys(): [string, string][] {
  return [...cache.entries()];
}
