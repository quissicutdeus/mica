// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every list store this bundle created that holds one character's rows, as the function that
 * empties it (MICA-384). `createCrudStore` and `createPagedStore` both register here, so the
 * shell's one call reaches contacts, notes and mail as well as messages and photos.
 *
 * A character switch reloads the shell but not these modules, so each store still held the
 * previous character's list — and a re-read the server refused left it on screen as the new
 * character's. Clearing on a character load is the shell's job; this registry is what lets it
 * reach stores it did not create. Strong references, which is right for what every store here
 * is: one per module, made at import and kept for the session.
 *
 * In-process only. A sandboxed add-on builds its own copy of this module inside its frame, so
 * its stores register in a registry the shell never reaches.
 *
 * Deliberately on no barrel (`NEVER_EXPORTED` in `publicSurface.test.ts`): an app able to call
 * `forgetCharacterStores` could blank every other app's list. The shell imports it by path.
 */
const characterStores = new Set<() => void>();
const forgetterOf = new WeakMap<object, () => void>();

/**
 * Put `store` in the registry, with what forgetting it means: no rows, `loaded` false, and
 * every round trip already in flight dropped when it lands. Called by the two store factories
 * as they build a store, so every store is per-character unless it opts out.
 */
export function registerCharacterStore(store: object, forget: () => void): void {
  characterStores.add(forget);
  forgetterOf.set(store, forget);
}

/**
 * Empty every per-character store: no rows, and `loaded` false until the next load comes
 * back, so an app shows its loading state rather than the last character's list. Called by the
 * shell when a character loads.
 */
export function forgetCharacterStores(): void {
  for (const forget of characterStores) forget();
}

/**
 * Opt a store out of `forgetCharacterStores`, for a list that is the same whichever character
 * is playing. Returns the store, so it wraps the `createCrudStore` or `createPagedStore` call.
 *
 * Every store is per-character unless it says otherwise, because forgetting a shared list
 * costs one reload and keeping a private one shows it to the wrong player. No in-tree store
 * opts out today.
 */
export function keepAcrossCharacters<S extends object>(store: S): S {
  const forget = forgetterOf.get(store);
  if (forget) characterStores.delete(forget);
  return store;
}
