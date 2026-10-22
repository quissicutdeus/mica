// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';
import type { AppProps } from '@mica/sdk';

const marketplaceMock = vi.hoisted(() => {
  const empty = { rows: [], nextCursor: null };
  const store = { subscribe: (fn: (v: typeof empty) => void) => (fn(empty), () => {}) };
  return {
    feedStore: store,
    mineStore: store,
    loadFeed: vi.fn().mockResolvedValue(undefined),
    loadMine: vi.fn().mockResolvedValue(undefined),
    searchListings: vi.fn().mockResolvedValue(empty),
    viewListing: vi.fn()
  };
});
vi.mock('@mica/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock
}));

import Marketplace from './index.svelte';

const listing = (id: number, title: string) => ({
  id,
  title,
  price: 100,
  description: '',
  status: 'active',
  attachments: [],
  contactPhone: null,
  isOwn: true
});

describe('Marketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    marketplaceMock.viewListing.mockImplementation(async (id: number) =>
      listing(id, id === 1 ? 'Dirt Bike' : 'Fishing Rod')
    );
  });

  /**
   * MICA-413: the app is resident, so a search result opening a second listing while the
   * first is still on screen changes `ListingDetail`'s `id` without remounting it, and it
   * loads only on mount and on foreground. It went on showing the first listing until the
   * player left the app and came back.
   */
  it('a deep link to another listing while one is open shows the new one', async () => {
    const { rerender } = renderApp<AppProps & { listingId?: number }>(Marketplace, {
      id: 'marketplace',
      props: { listingId: 1 }
    });
    await waitFor(() => screen.getByText('Dirt Bike'));

    // `renderApp` types `rerender` as `AppProps` only; this app also takes `listingId`.
    const deepLink: (props: Partial<AppProps & { listingId?: number }>) => Promise<void> = rerender;
    await deepLink({ listingId: 2 });
    await waitFor(() => screen.getByText('Fishing Rod'));
    expect(marketplaceMock.viewListing).toHaveBeenLastCalledWith(2);
    expect(screen.queryByText('Dirt Bike')).toBeNull();
  });

  /**
   * MICA-418: Detail and My Listings each drew a second "←" back button in the body, on top
   * of `Screen`'s own, which `useAppLevels` already points at the level below. One back
   * control per screen, and that one still leaves each level for the feed.
   */
  it('a listing has only the header back, and it returns to the feed', async () => {
    const { onback } = renderApp<AppProps & { listingId?: number }>(Marketplace, {
      id: 'marketplace',
      props: { listingId: 1 }
    });
    await waitFor(() => screen.getByText('Dirt Bike'));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => screen.getByPlaceholderText('Search listings'));
    expect(screen.queryByText('Dirt Bike')).toBeNull();
    expect(onback).not.toHaveBeenCalled();
  });

  it('My Listings has only the header back, and it returns to the feed', async () => {
    const { onback } = renderApp(Marketplace, { id: 'marketplace' });
    await fireEvent.click(screen.getByRole('button', { name: 'My Listings' }));
    await waitFor(() => screen.getByText('No listings yet'));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => screen.getByPlaceholderText('Search listings'));
    expect(onback).not.toHaveBeenCalled();
  });
});
