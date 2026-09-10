// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { onDestroy } from 'svelte';
import { guarded } from './guard';
import type { ProvidedHit } from './facets';

export type { ProvidedHit } from './facets';

/**
 * Warned-about apps, so a provider that throws on every keystroke says so once rather than
 * filling the console with one line per character typed.
 */
const warned = new Set<string>();

/**
 * Contribute this app's own rows to the phone's search (MICA-286).
 *
 * The home-screen search knows how to find an app, a contact, a conversation, a photo, a
 * mail and a listing, because the shell holds all six. It holds nothing an app owns — and
 * for a `core: false` add-on it never can: core may not name an app the Store installs
 * (`sdk/coreBoundary.test.ts`), and an add-on's rows live inside a sandboxed frame the
 * shell cannot read. This is how they get listed anyway.
 *
 * ```ts
 * useSearchProvider('notes', (needle) =>
 *   filterByQuery($notes, needle, (n) => [n.title, n.content]).map((note) => ({
 *     id: note.id,
 *     title: note.title,
 *     subtitle: note.content,
 *     props: { noteId: note.id }
 *   }))
 * );
 * ```
 *
 * **`search` runs where the app runs**, on the app's own rows, and only the hits it returns
 * are handed to the shell. `needle` is already trimmed and lower-cased, and is never empty:
 * an empty query clears this app's rows without asking it anything.
 *
 * **`props` is a deep link into this app**, the same object `useDeepLink` reads back —
 * `openApp(appId, props)` is what a tap does. An app with no deep link may omit it and the
 * row opens the app root, which is the honest fallback rather than a dead tap.
 *
 * Three things follow from residency, and they are the reason this is a hook rather than a
 * manifest field:
 *
 * - **The app has to be running.** Apps mount on first open and stay mounted, so a phone
 *   that has never opened this app in this session lists nothing from it. That is a real
 *   limit and not a bug this hook can fix — an app that is not running has no code in
 *   memory to ask.
 * - **Nothing is fetched for a search.** `search` is synchronous by construction, so it
 *   answers from what the app already holds. An app that wants its rows findable before it
 *   is opened should declare a `preload` in its manifest, which is what fills those caches.
 * - **The subscription ends with the component.** The returned function releases it early
 *   for a caller that wants a provider scoped to one screen; unmount does it otherwise.
 *
 * A `search` that throws is caught here: the phone's search must not break because one app
 * did, so this app contributes nothing for that keystroke and the rest of the list is
 * unaffected.
 */
export function useSearchProvider(
  appId: string,
  search: (needle: string) => ProvidedHit[]
): () => void {
  const { query, publish } = guarded('useSearchProvider', appId).facets.searchProvider(appId);

  const unsubscribe = query.subscribe((needle) => {
    // Nothing is being searched, so there is nothing to answer: the shell drops every
    // app's hits when the needle empties rather than waiting to be told.
    if (!needle) return;
    let hits: ProvidedHit[] = [];
    try {
      hits = search(needle);
    } catch (error) {
      if (!warned.has(appId)) {
        warned.add(appId);
        console.warn(`[micaOS] '${appId}' search provider threw; it contributes no results`, error);
      }
    }
    publish(needle, hits);
  });

  try {
    onDestroy(unsubscribe);
  } catch {
    // Called outside a component lifecycle; the returned function is the caller's to hold
    // onto, as with `onAppForeground`.
  }
  return unsubscribe;
}
