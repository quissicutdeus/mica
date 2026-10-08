// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlabberDm } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import { mockAccounts, mockBlocks } from '../social';

const mockDms: BlabberDm[] = [
  {
    id: 1,
    from_account: 2,
    to_account: 1,
    body: 'saw your post, funny stuff',
    read_at: null,
    status: 'active',
    created_at: '2026-08-02T12:30:00Z',
    updated_at: '2026-08-02T12:30:00Z'
  }
];

let nextDmId = 50;

export const mocks: Record<string, MockHandler> = {
  // Blabber DMs. 1:1, so a thread is the union of both directions between two accounts.
  //
  // Scoped keys throughout Blabber, for the same reason Notes' are: it is `core: false` and
  // reaches its service through the generic route, so a request arrives as
  // `{ service: 'blabber_dms', action: 'threads' }` rather than as `getDmThreads`. The key is the
  // server's own action name, which is what makes a mock that disagrees with the server visible.
  'blabber_dms:threads': () => {
    const peers = new Map<number, (typeof mockDms)[number]>();
    for (const dm of [...mockDms].sort((a, b) => b.id - a.id)) {
      const peer = dm.from_account === 1 ? dm.to_account : dm.from_account;
      if (!peers.has(peer)) peers.set(peer, dm);
    }
    return [...peers.entries()].map(([peer_account_id, last]) => {
      const account = mockAccounts.find((a) => a.id === peer_account_id);
      return {
        peer_account_id,
        handle: account?.handle ?? null,
        display_name: account?.display_name ?? null,
        last,
        unread: mockDms.filter(
          (d) => d.to_account === 1 && d.from_account === peer_account_id && !d.read_at
        ).length
      };
    });
  },
  'blabber_dms:get': ({ peer_account_id }: { peer_account_id: number }) => {
    const rows = mockDms
      .filter(
        (d) =>
          (d.from_account === 1 && d.to_account === peer_account_id) ||
          (d.from_account === peer_account_id && d.to_account === 1)
      )
      .sort((a, b) => b.id - a.id);
    return { rows, nextCursor: null };
  },
  'blabber_dms:send': ({ peer_account_id, body }: { peer_account_id: number; body: string }) => {
    // Bidirectional, matching the server: either side's block refuses the send.
    if (
      mockBlocks.some(
        (b) =>
          (b.blocker === 1 && b.blocked === peer_account_id) ||
          (b.blocker === peer_account_id && b.blocked === 1)
      )
    ) {
      throw new Error("You can't message this account.");
    }
    const created = {
      id: nextDmId++,
      from_account: 1,
      to_account: peer_account_id,
      body,
      read_at: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockDms.push(created);
    return created;
  },
  'blabber_dms:read': ({ peer_account_id }: { peer_account_id: number }) => {
    for (const dm of mockDms) {
      if (dm.to_account === 1 && dm.from_account === peer_account_id) {
        dm.read_at = new Date().toISOString();
      }
    }
    return true;
  }
};
