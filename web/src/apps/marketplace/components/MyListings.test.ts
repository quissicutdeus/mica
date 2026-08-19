// @vitest-environment jsdom
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
vi.mock('../../../sdk/hooks/useMarketplace', () => ({ useMarketplace: () => marketplaceMock }));

import MyListings from './MyListings.svelte';

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
