// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { useService } from '../../../sdk/host/useService';
import type { Listing } from '@mica/shared/types';
import type { CreateListingInput, ListingPage } from '@mica/sdk';

const service = () => useService('marketplace');

const emptyPage: ListingPage = { rows: [], nextCursor: null };

/** The public feed — active listings, newest first. */
export const feedStore = writable<ListingPage>({ ...emptyPage });
/** The caller's own listings, every status. */
export const mineStore = writable<ListingPage>({ ...emptyPage });

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
