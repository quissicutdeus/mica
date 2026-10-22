// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Listing } from '@mica/shared/types';
import { mockListings } from '../data';
import type { MockHandler } from '../registry';

/**
 * The listings this mock's player put up. Kept beside the rows rather than as a `citizenid` on
 * them: no listing on the wire names its seller (MICA-433), and `view`'s `isOwn` is how the
 * server answers "is this mine" without one.
 */
const mine = new Set<number>([1]);

export const mocks: Record<string, MockHandler> = {
  'marketplace:feed': () => ({
    rows: mockListings.filter((l) => l.status === 'active'),
    nextCursor: null
  }),
  'marketplace:search': ({ q = '' }: { q?: string } = {}) => ({
    rows: mockListings.filter(
      (l) =>
        l.status === 'active' &&
        (l.title.toLowerCase().includes(q.toLowerCase()) ||
          l.description.toLowerCase().includes(q.toLowerCase()))
    ),
    nextCursor: null
  }),
  'marketplace:mine': () => ({ rows: mockListings, nextCursor: null }),
  'marketplace:view': ({ id }: { id: number }) => {
    const listing = mockListings.find((l) => l.id === id);
    return listing ? { ...listing, contactPhone: '555-0100', isOwn: mine.has(listing.id) } : null;
  },
  'marketplace:create': ({
    title,
    price,
    description
  }: {
    title: string;
    price: number;
    description: string;
  }) => {
    const id = Math.max(0, ...mockListings.map((l) => l.id)) + 1;
    const now = new Date().toISOString();
    const created: Listing = {
      id,
      title,
      price,
      description,
      status: 'active',
      created_at: now,
      updated_at: now,
      attachments: []
    };
    mockListings.push(created);
    mine.add(id);
    return created;
  },
  'marketplace:markSold': ({ id }: { id: number }) => {
    const listing = mockListings.find((l) => l.id === id);
    if (listing) listing.status = 'sold';
    return !!listing;
  },
  'marketplace:remove': ({ id }: { id: number }) => {
    const listing = mockListings.find((l) => l.id === id);
    if (listing) listing.status = 'removed';
    return !!listing;
  }
};
