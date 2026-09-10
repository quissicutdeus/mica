// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import { useService } from '../../../sdk/host/useService';
import type { Listing } from '@mica/shared/types';
import type { CreateListingInput, ListingPage } from '@mica/sdk';

const service = () => useService('marketplace');

const emptyPage: ListingPage = { rows: [], nextCursor: null };

/** The public feed — active listings, newest first. */
export const feedStore = writable<ListingPage>({ ...emptyPage });
/** The caller's own listings, every status. */
export const mineStore = writable<ListingPage>({ ...emptyPage });

/**
 * Every listing either window holds, once each, for the home search (MICA-248).
 *
 * The feed and "mine" overlap on the caller's own active listings, and a row that is in
 * both would otherwise be two identical hits. Only `active` rows: a sold or removed
 * listing is not something a tap can buy, and the feed never shows one either.
 */
export const cachedListings = derived([feedStore, mineStore], ([$feed, $mine]) => {
  const seen = new Set<number>();
  return [...$feed.rows, ...$mine.rows].filter((row) => {
    if (row.status !== 'active' || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
});

/**
 * Whether a listing answers a home-search query — title or description, the same two
 * columns the server's `search` action reads. `needle` is trimmed and lower-cased by the
 * caller; `searchEverything` owns the shared ranking rule and this is Snatchr's half.
 */
export const matchesListing = (listing: Listing, needle: string): boolean =>
  [listing.title, listing.description].some((value) => value?.toLowerCase().includes(needle));

/**
 * The cached listings matching `query`. Distinct from `searchListings` below, which asks
 * the server: this one never fetches, which is what the home search needs from it.
 */
export const searchCachedListings = (query: string): Listing[] => {
  const needle = query.trim().toLowerCase();
  return needle ? get(cachedListings).filter((row) => matchesListing(row, needle)) : [];
};

export const loadFeed = async (): Promise<void> => {
  const page = await service().call<ListingPage>('feed', {}, emptyPage);
  feedStore.set(page);
};

export const searchListings = async (q: string): Promise<ListingPage> =>
  service().call<ListingPage>('search', { q }, emptyPage);

export const loadMine = async (): Promise<void> => {
  const page = await service().call<ListingPage>('mine', {}, emptyPage);
  mineStore.set(page);
};

export const viewListing = async (
  id: number
): Promise<(Listing & { contactPhone: string | null; isOwn: boolean }) | null> =>
  service().call('view', { id }, null);

export const postListing = async (input: CreateListingInput): Promise<Listing> => {
  const created = await service().call<Listing>('create', input);
  mineStore.update((page) => ({ ...page, rows: [created, ...page.rows] }));
  feedStore.update((page) => ({ ...page, rows: [created, ...page.rows] }));
  return created;
};

const setMineStatus = (id: number, status: Listing['status']): void => {
  mineStore.update((page) => ({
    ...page,
    rows: page.rows.map((row) => (row.id === id ? { ...row, status } : row))
  }));
};

export const markSold = async (id: number): Promise<boolean> => {
  const ok = await service().call<boolean>('markSold', { id }, false);
  if (ok) setMineStatus(id, 'sold');
  return ok;
};

export const removeListing = async (id: number): Promise<boolean> => {
  const ok = await service().call<boolean>('remove', { id }, false);
  if (ok) setMineStatus(id, 'removed');
  return ok;
};
