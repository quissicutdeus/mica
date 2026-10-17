// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Account, DirectMessage, DirectMessageThread } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import { mockAccounts, mockBlocks, mockOwnedAccountIds } from '../social';

const mockDms: DirectMessage[] = [
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

/**
 * The apps that registered a DM policy on the server (`registerDmPolicy` in
 * `server/services/DirectMessages.ts`). Blabber's is in `Blabber.ts` and is the only one
 * today. Default-deny, as the server is: `app` is a payload field, so a mock that served any
 * app it was named would let `pnpm dev` and the e2e suite pass on an app the game refuses.
 */
const APPS_WITH_A_POLICY: ReadonlySet<string> = new Set(['blabber']);

const policyFor = (app: string): void => {
  if (!APPS_WITH_A_POLICY.has(app)) throw new Error("This app doesn't support direct messages.");
};

/** The player's active accounts in one app — the server's `accountsOwnedBy`. */
const ownedIn = (app: string): Account[] =>
  mockAccounts.filter(
    (a) => a.app === app && mockOwnedAccountIds.has(a.id) && (a.status ?? 'active') === 'active'
  );

/** The server's `ownedAccount`: the caller owns `account_id`, and it lives in `app`. */
const ownedAccount = (account_id: number, app: string): Account => {
  const mine = ownedIn(app).find((a) => a.id === account_id);
  if (!mine) throw new Error('That account is not yours.');
  return mine;
};

const between = (a: number, b: number) => (d: DirectMessage) =>
  (d.from_account === a && d.to_account === b) || (d.from_account === b && d.to_account === a);

export const mocks: Record<string, MockHandler> = {
  // Direct messages for any social app (MICA-390). 1:1, so a thread is the union of both
  // directions between two accounts.
  //
  // Scoped keys, as the server names them: the store reaches `dms` through the generic route,
  // so a request arrives as `{ service: 'dms', action: 'threads' }`. Every action names its
  // `app` and the mock reads it rather than assuming Blabber, exactly as the handlers do.
  'dms:threads': ({ app }: { app: string }): DirectMessageThread[] => {
    policyFor(app);
    const mine = new Set(ownedIn(app).map((a) => a.id));
    if (mine.size === 0) return [];
    const peers = new Map<number, DirectMessage>();
    for (const dm of [...mockDms].sort((a, b) => b.id - a.id)) {
      if (dm.status !== 'active') continue;
      const fromMine = mine.has(dm.from_account);
      if (!fromMine && !mine.has(dm.to_account)) continue;
      const peer = fromMine ? dm.to_account : dm.from_account;
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
          (d) =>
            mine.has(d.to_account) &&
            d.from_account === peer_account_id &&
            d.status === 'active' &&
            !d.read_at
        ).length
      };
    });
  },
  'dms:get': ({
    app,
    account_id,
    peer_account_id
  }: {
    app: string;
    account_id: number;
    peer_account_id: number;
  }) => {
    policyFor(app);
    const mine = ownedAccount(account_id, app);
    const rows = mockDms
      .filter((d) => d.status === 'active' && between(mine.id, peer_account_id)(d))
      .sort((a, b) => b.id - a.id);
    return { rows, nextCursor: null };
  },
  'dms:send': ({
    app,
    account_id,
    peer_account_id,
    body
  }: {
    app: string;
    account_id: number;
    peer_account_id: number;
    body: string;
  }) => {
    policyFor(app);
    const text = body.trim();
    if (!text) throw new Error('A message needs something in it.');
    const mine = ownedAccount(account_id, app);
    if (peer_account_id === mine.id) throw new Error('You cannot message yourself.');
    // The peer is an active account **in the same app**: an account in another app is
    // "no such account", as `activeAccount(peerId, data.app)` answers it on the server.
    const peer = mockAccounts.find(
      (a) => a.id === peer_account_id && a.app === app && (a.status ?? 'active') === 'active'
    );
    if (!peer) throw new Error('No such account.');
    // Bidirectional, matching the server: either side's block refuses the send.
    if (
      mockBlocks.some(
        (b) =>
          (b.blocker === mine.id && b.blocked === peer.id) ||
          (b.blocker === peer.id && b.blocked === mine.id)
      )
    ) {
      throw new Error("You can't message this account.");
    }
    const created: DirectMessage = {
      id: nextDmId++,
      from_account: mine.id,
      to_account: peer.id,
      body: text,
      read_at: null,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockDms.push(created);
    return created;
  },
  'dms:read': ({
    app,
    account_id,
    peer_account_id
  }: {
    app: string;
    account_id: number;
    peer_account_id: number;
  }) => {
    policyFor(app);
    const mine = ownedAccount(account_id, app);
    for (const dm of mockDms) {
      if (dm.to_account === mine.id && dm.from_account === peer_account_id) {
        dm.read_at = new Date().toISOString();
      }
    }
    return true;
  }
};
