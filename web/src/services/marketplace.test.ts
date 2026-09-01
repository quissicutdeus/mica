// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({ call: vi.fn() }));
/**
 * MICA-172: the specifier below is a **bare string** and TypeScript never checks it, so a
 * mock whose target has moved silently stops applying and every assertion here starts
 * passing against the real module. That is not hypothetical — the identical shape broke
 * `settingsSync.test.ts` during this ticket's first move commit, and was only noticed
 * because assertions happened to fail nearby. The `import type` below is inert at runtime
 * and exists solely so the compiler fails if this path ever stops resolving.
 */
import type * as UseServiceModule from '../../../sdk/host/useService';
void (null as unknown as typeof UseServiceModule);
vi.mock('../../../sdk/host/useService', () => ({ useService: () => serviceMock }));

import {
  feedStore,
  mineStore,
  loadFeed,
  loadMine,
  postListing,
  markSold,
  removeListing
} from './marketplace';

describe('marketplace client store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feedStore.set({ rows: [], nextCursor: null });
    mineStore.set({ rows: [], nextCursor: null });
  });

  it('loadFeed populates feedStore from the feed action', async () => {
    serviceMock.call.mockResolvedValue({ rows: [{ id: 1 }], nextCursor: null });
    await loadFeed();
    expect(serviceMock.call).toHaveBeenCalledWith('feed', {}, { rows: [], nextCursor: null });
    expect(get(feedStore).rows).toEqual([{ id: 1 }]);
  });

  it('loadMine populates mineStore from the mine action', async () => {
    serviceMock.call.mockResolvedValue({ rows: [{ id: 2 }], nextCursor: null });
    await loadMine();
    expect(serviceMock.call).toHaveBeenCalledWith('mine', {}, { rows: [], nextCursor: null });
    expect(get(mineStore).rows).toEqual([{ id: 2 }]);
  });

  it('postListing calls create with the form fields and prepends the result to mineStore and feedStore', async () => {
    serviceMock.call.mockResolvedValue({
      id: 3,
      title: 'New',
      price: 10,
      description: 'd',
      status: 'active'
    });
    await postListing({ title: 'New', price: 10, description: 'd', attachments: [] });
    expect(serviceMock.call).toHaveBeenCalledWith('create', {
      title: 'New',
      price: 10,
      description: 'd',
      attachments: []
    });
    expect(get(mineStore).rows[0].id).toBe(3);
    expect(get(feedStore).rows[0].id).toBe(3);
  });

  it('markSold updates the row status in mineStore optimistically on success', async () => {
    mineStore.set({ rows: [{ id: 1, status: 'active' } as any], nextCursor: null });
    serviceMock.call.mockResolvedValue(true);
    await markSold(1);
    expect(get(mineStore).rows[0].status).toBe('sold');
  });

  it('markSold leaves the row alone when the server refuses', async () => {
    mineStore.set({ rows: [{ id: 1, status: 'active' } as any], nextCursor: null });
    serviceMock.call.mockResolvedValue(false);
    await markSold(1);
    expect(get(mineStore).rows[0].status).toBe('active');
  });

  it('removeListing updates the row status in mineStore optimistically on success', async () => {
    mineStore.set({ rows: [{ id: 1, status: 'active' } as any], nextCursor: null });
    serviceMock.call.mockResolvedValue(true);
    await removeListing(1);
    expect(get(mineStore).rows[0].status).toBe('removed');
  });
});
