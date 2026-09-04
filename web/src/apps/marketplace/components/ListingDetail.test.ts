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
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => ({ viewListing: vi.fn() }));
const callMock = vi.hoisted(() => ({ startCall: vi.fn() }));
const messagesMock = vi.hoisted(() => ({ startText: vi.fn() }));

vi.mock('@mica/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock,
  useCall: () => callMock,
  useMessages: () => messagesMock
}));

import ListingDetail from './ListingDetail.svelte';

import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `marketplace` namespace for the running app.
// This test renders one screen on its own, so it stands in for the entry point —
// otherwise every `$t` here resolves to its own key.
registerMessages('marketplace', { en, de });

const listing = {
  id: 1,
  title: 'Dirt Bike',
  price: 4500,
  description: 'Runs great',
  status: 'active',
  attachments: [],
  contactPhone: '555-0100',
  isOwn: false
};

describe('ListingDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders title, price, description, and never renders the raw phone number', async () => {
    marketplaceMock.viewListing.mockResolvedValue(listing);
    render(ListingDetail, { props: { id: 1, onback: () => {} } });
    await waitFor(() => screen.getByText('Dirt Bike'));
    expect(screen.getByText('4500')).toBeTruthy();
    expect(screen.getByText('Runs great')).toBeTruthy();
    expect(screen.queryByText('555-0100')).toBeNull();
  });

  it('Call button starts a call to the resolved contactPhone', async () => {
    marketplaceMock.viewListing.mockResolvedValue(listing);
    render(ListingDetail, { props: { id: 1, onback: () => {} } });
    await waitFor(() => screen.getByText('Call'));
    await fireEvent.click(screen.getByText('Call'));
    expect(callMock.startCall).toHaveBeenCalledWith('555-0100');
  });

  it('Text button starts a text to the resolved contactPhone', async () => {
    marketplaceMock.viewListing.mockResolvedValue(listing);
    render(ListingDetail, { props: { id: 1, onback: () => {} } });
    await waitFor(() => screen.getByText('Text'));
    await fireEvent.click(screen.getByText('Text'));
    expect(messagesMock.startText).toHaveBeenCalledWith('555-0100');
  });

  it("hides Report when the listing is the viewer's own", async () => {
    marketplaceMock.viewListing.mockResolvedValue({ ...listing, isOwn: true });
    render(ListingDetail, { props: { id: 1, onback: () => {} } });
    await waitFor(() => screen.getByText('Dirt Bike'));
    expect(screen.queryByLabelText(/Report/)).toBeNull();
  });

  it('shows Report when the listing is not the viewer’s own', async () => {
    marketplaceMock.viewListing.mockResolvedValue(listing);
    render(ListingDetail, { props: { id: 1, onback: () => {} } });
    await waitFor(() => screen.getByLabelText(/Report/));
    expect(screen.getByLabelText(/Report/)).toBeTruthy();
  });
});
