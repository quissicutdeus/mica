// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => {
  // A minimal store, not `writable` from 'svelte/store' — that import would sit below
  // this hoisted block at runtime and hit a TDZ error, since `vi.mock` factories run
  // before any of this file's own top-level statements, imports included.
  let state = { rows: [] as any[], nextCursor: null as number | null };
  const subs = new Set<(v: typeof state) => void>();
  const feedStore = {
    subscribe: (fn: (v: typeof state) => void) => {
      subs.add(fn);
      fn(state);
      return () => subs.delete(fn);
    },
    set: (next: typeof state) => {
      state = next;
      subs.forEach((fn) => fn(state));
    }
  };
  return {
    feedStore,
    loadFeed: vi.fn().mockResolvedValue(undefined),
    searchListings: vi.fn().mockResolvedValue({ rows: [], nextCursor: null })
  };
});
vi.mock('@gphone/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock
}));

import Feed from './Feed.svelte';

import { registerMessages } from '@gphone/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `marketplace` namespace for the running app.
// This test renders one screen on its own, so it stands in for the entry point —
// otherwise every `$t` here resolves to its own key.
registerMessages('marketplace', { en, de });

describe('Marketplace Feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    marketplaceMock.feedStore.set({
      rows: [
        { id: 1, title: 'Dirt Bike', price: 4500, description: 'runs great', attachments: [] }
      ],
      nextCursor: null
    });
  });

  it('renders each listing with title and price', async () => {
    render(Feed, { props: { onselect: () => {}, onCreate: () => {}, onMyListings: () => {} } });
    expect(await screen.findByText('Dirt Bike')).toBeTruthy();
    expect(screen.getByText('4500')).toBeTruthy();
  });

  it('tapping a card calls onselect with the listing id', async () => {
    const onselect = vi.fn();
    render(Feed, { props: { onselect, onCreate: () => {}, onMyListings: () => {} } });
    await fireEvent.click(await screen.findByText('Dirt Bike'));
    expect(onselect).toHaveBeenCalledWith(1);
  });

  it('typing in search calls searchListings with the query, debounced', async () => {
    vi.useFakeTimers();
    marketplaceMock.searchListings.mockResolvedValue({ rows: [], nextCursor: null });
    render(Feed, { props: { onselect: () => {}, onCreate: () => {}, onMyListings: () => {} } });
    await fireEvent.input(screen.getByPlaceholderText('Search listings'), {
      target: { value: 'bike' }
    });
    await vi.advanceTimersByTimeAsync(350);
    expect(marketplaceMock.searchListings).toHaveBeenCalledWith('bike');
    vi.useRealTimers();
  });

  it('tapping Create calls onCreate', async () => {
    const onCreate = vi.fn();
    render(Feed, { props: { onselect: () => {}, onCreate, onMyListings: () => {} } });
    await fireEvent.click(screen.getByLabelText('Create listing'));
    expect(onCreate).toHaveBeenCalled();
  });

  it('tapping My Listings calls onMyListings', async () => {
    const onMyListings = vi.fn();
    render(Feed, { props: { onselect: () => {}, onCreate: () => {}, onMyListings } });
    await fireEvent.click(screen.getByText('My Listings'));
    expect(onMyListings).toHaveBeenCalled();
  });
});
