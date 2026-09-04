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
  let state = {
    rows: [
      { id: 1, title: 'Active One', price: 10, status: 'active' },
      { id: 2, title: 'Sold One', price: 20, status: 'sold' }
    ] as any[],
    nextCursor: null as number | null
  };
  const subs = new Set<(v: typeof state) => void>();
  const mineStore = {
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
    mineStore,
    loadMine: vi.fn().mockResolvedValue(undefined),
    markSold: vi.fn().mockResolvedValue(true),
    removeListing: vi.fn().mockResolvedValue(true)
  };
});
vi.mock('@mica/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock
}));

import MyListings from './MyListings.svelte';

import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `marketplace` namespace for the running app.
// This test renders one screen on its own, so it stands in for the entry point —
// otherwise every `$t` here resolves to its own key.
registerMessages('marketplace', { en, de });

describe('MyListings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Mark Sold / Remove only for active rows', async () => {
    render(MyListings, { props: { onback: () => {} } });
    const activeRow = (await screen.findByText('Active One')).closest('li')!;
    const soldRow = screen.getByText('Sold One').closest('li')!;
    expect(activeRow.querySelector('button[aria-label="Mark Sold"]')).toBeTruthy();
    expect(soldRow.querySelector('button[aria-label="Mark Sold"]')).toBeNull();
  });

  it('tapping Mark Sold calls markSold with the row id', async () => {
    render(MyListings, { props: { onback: () => {} } });
    await screen.findByText('Active One');
    await fireEvent.click(screen.getByLabelText('Mark Sold'));
    expect(marketplaceMock.markSold).toHaveBeenCalledWith(1);
  });

  it('tapping Remove calls removeListing with the row id', async () => {
    render(MyListings, { props: { onback: () => {} } });
    await screen.findByText('Active One');
    await fireEvent.click(screen.getByLabelText('Remove'));
    expect(marketplaceMock.removeListing).toHaveBeenCalledWith(1);
  });
});
