// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => ({ viewListing: vi.fn() }));
const callMock = vi.hoisted(() => ({ startCall: vi.fn() }));
const messagesMock = vi.hoisted(() => ({ startText: vi.fn() }));

vi.mock('@gphone/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock,
  useCall: () => callMock,
  useMessages: () => messagesMock
}));

import ListingDetail from './ListingDetail.svelte';

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
