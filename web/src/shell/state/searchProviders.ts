// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable } from 'svelte/store';
import type { ProvidedHit } from '@mica/sdk';
import { searchQuery } from './appDrawer';
import type { SearchProvider } from './searchResults';

/**
 * The shell's half of `useSearchProvider` (MICA-286).
 *
 * `searchEverything` wants a `SearchProvider` — an object with a **synchronous** `search`
 * — and an app cannot be one. A `core: false` add-on runs in a sandboxed frame whose only
 * route to the shell is `postMessage`, so it can neither hand a function across nor be
 * called back through one: the seam pushes store values *into* a frame and answers calls
 * *out* of it, and has no shell-to-frame call direction at all.
 *
 * So the direction is inverted rather than a call added. The shell publishes the needle
 * (`searchNeedle`), each running app answers with the hits it chose (`publishSearchHits`),
 * and this file turns the last answer into the synchronous provider the drawer asks. The
 * hits are already here by the time `searchEverything` runs; `search` is a lookup, not a
 * round trip.
 */

/**
 * How many hits one app may hold here.
 *
 * Four times what the drawer will draw (`SEARCH_RESULTS_PER_GROUP`), because this cap is
 * not about the list — it is about what an add-on can make the shell keep. A frame that
 * published fifty thousand rows per keystroke would otherwise hold all of them in shell
 * memory, and the per-group slice further down would hide that it had. The slack over five
 * is deliberate: an app that ranks its own hits and publishes a few spares is doing nothing
 * wrong, and truncating at exactly the display cap would make the two numbers one.
 */
export const MAX_HITS_PER_APP = 20;

/** What one app last answered, and the needle it answered for. */
interface PublishedHits {
  needle: string;
  hits: ProvidedHit[];
}

const published = writable<Record<string, PublishedHits>>({});

/**
 * The needle every provider is answering, derived from the drawer's own input so nothing
 * has to remember to keep a second copy in step. Trimmed and lower-cased to match what
 * `searchEverything` passes a provider's `search`, and `''` whenever the drawer is closed
 * or empty (`closeDrawer` clears the query).
 */
export const searchNeedle: Readable<string> = derived(searchQuery, ($q) => $q.trim().toLowerCase());

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What survives of what a frame sent.
 *
 * Every field here arrived over `postMessage` from a sandboxed add-on, so it is a claim
 * rather than a value: the row shape is not enforced by the frame's own TypeScript, which
 * an attacker-controlled bundle simply does not have. A malformed hit is dropped rather
 * than rendered as `undefined`, and the cap is applied before anything is stored.
 *
 * `props` is *not* validated beyond being a plain object, and deliberately so: it is
 * handed straight back to `openApp(appId, props)` for the same app that published it, so
 * its contents are that app's own business. The shell reads none of it.
 */
const sanitize = (hits: unknown): ProvidedHit[] => {
  if (!Array.isArray(hits)) return [];
  return hits.slice(0, MAX_HITS_PER_APP).flatMap((hit): ProvidedHit[] => {
    if (!isPlainObject(hit)) return [];
    const { id, title, subtitle, props } = hit;
    if (typeof id !== 'string' && typeof id !== 'number') return [];
    if (typeof title !== 'string' || !title.trim()) return [];
    return [
      {
        id,
        title,
        subtitle: typeof subtitle === 'string' ? subtitle : undefined,
        props: isPlainObject(props) ? props : undefined
      }
    ];
  });
};

/**
 * One app's answer for one needle.
 *
 * `appId` comes from the facet's factory argument, which `IframeHostServer` pins to the
 * calling frame's own id — a frame cannot publish under another app's heading whatever it
 * puts on the wire.
 *
 * **A reply for a needle that is no longer being searched is dropped, not shown.** The
 * round trip through a frame takes a message each way, so a reply for `not` can land after
 * the player has typed `note`; keeping it would list rows that match neither what was
 * typed nor what is on screen. Dropping it costs nothing — the frame is already answering
 * the newer needle, because the newer needle is what it was pushed.
 */
export function publishSearchHits(appId: string, needle: unknown, hits: unknown): void {
  if (typeof needle !== 'string') return;
  // An empty needle is not a search, and an entry answering one would only survive the
  // clear below to say nothing. Refused here rather than left to that ordering.
  if (!needle) return;
  if (needle !== get(searchNeedle)) return;
  const clean = sanitize(hits);
  published.update((current) => ({ ...current, [appId]: { needle, hits: clean } }));
}

/**
 * Every running app's last answer, as the drawer's `SearchProvider[]`.
 *
 * The second stale check lives in `search` itself rather than only at publish time: the
 * needle can move between a publish and the render that reads it, and a provider that
 * answered the previous needle must contribute nothing rather than yesterday's rows.
 * `searchEverything` still decides whether the app is visible at all and still caps the
 * group — this only decides whether the answer is current.
 */
export const searchProviders: Readable<SearchProvider[]> = derived(published, ($published) =>
  Object.entries($published).map(([appId, answer]) => ({
    appId,
    search: (needle: string): ProvidedHit[] => (needle === answer.needle ? answer.hits : [])
  }))
);

/**
 * Forget everything once nothing is being searched.
 *
 * Held hits are a snapshot of rows an app owns — note titles, message subjects — and there
 * is no reason for the shell to keep them after the drawer closes. Subscribed at module
 * scope because this is a shell singleton with one lifetime; the drawer does not have to
 * remember to call it, which is what stops the cache outliving a search nobody is running.
 */
searchNeedle.subscribe((needle) => {
  if (!needle) published.set({});
});
