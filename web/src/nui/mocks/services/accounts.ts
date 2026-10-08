// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Account } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import { mockAccounts, mockOwnedAccountIds, mockFollows, mockBlocks } from '../social';

const mockReactions: { account: number; table: string; target: number; emoji: string }[] = [];

interface FollowListArgs {
  account_id: number;
  cursor?: number;
  limit?: number;
}

/**
 * One page of accounts out of a list of ids, newest relation first.
 *
 * Only `active` accounts, as the server's join requires — a moderated account drops out of a
 * follower list and makes the page shorter than asked for, which is correct and is a thing the
 * browser should be able to reproduce.
 */
const mockFollowPage = (accountIds: number[], cursor: number | undefined, limit: number) => {
  const newestFirst = [...accountIds].reverse();
  const from = cursor ?? 0;
  const slice = newestFirst.slice(from, from + limit);
  const rows = slice
    .map((id) => mockAccounts.find((a) => a.id === id && a.status === 'active'))
    .filter((a): a is Account => a !== undefined);
  const end = from + limit;
  return { rows, nextCursor: end < newestFirst.length ? end : null };
};
let nextAccountId = 10;

/** Mirrors `mica_max_accounts_per_app`'s default. The server is the boundary. */
const MOCK_ACCOUNT_LIMIT = 3;

export const mocks: Record<string, MockHandler> = {
  // Accounts. `limit` is the per-app cap the server reports from a convar — matched here
  // because a mock that omitted it would hide the Claim button in `pnpm dev` and show it
  // in game, or the reverse.
  'accounts:mine': () => ({
    rows: mockAccounts.filter((a) => a.app === 'blabber' && mockOwnedAccountIds.has(a.id)),
    limit: MOCK_ACCOUNT_LIMIT
  }),
  'accounts:create': ({ handle, display_name }: { handle: string; display_name?: string }) => {
    if (mockAccounts.some((a) => a.handle === handle)) throw new Error(`@${handle} is taken.`);
    if (mockOwnedAccountIds.size >= MOCK_ACCOUNT_LIMIT) {
      throw new Error(`You already hold ${MOCK_ACCOUNT_LIMIT} accounts here.`);
    }
    const created: Account = {
      id: nextAccountId++,
      app: 'blabber',
      handle,
      display_name: display_name ?? null,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockAccounts.push(created);
    mockOwnedAccountIds.add(created.id);
    return created;
  },
  /**
   * The generic owner-scoped update, which answers a bare boolean.
   *
   * `handle` and `app` are ignored rather than applied, because they are
   * `clientWritable: false` on the server and `ServiceEndpoint` drops them before SQL. A mock
   * that honored them would let a rename look like it worked here and fail in game.
   */
  updateAccount: ({
    id,
    display_name,
    avatar,
    bio
  }: {
    id: number;
    display_name?: string | null;
    avatar?: string | null;
    bio?: string | null;
  }) => {
    // Owner-scoped, as the generic update is: a row id alone is never authorization (§2.9).
    const account = mockAccounts.find((a) => a.id === id && mockOwnedAccountIds.has(a.id));
    if (!account) return false;
    if (display_name !== undefined) account.display_name = display_name;
    if (avatar !== undefined) account.avatar = avatar;
    if (bio !== undefined) account.bio = bio;
    account.updated_at = new Date().toISOString();
    return true;
  },
  getAccounts: ({ handle, limit = 30 }: { handle?: string; limit?: number } = {}) => {
    const matches = mockAccounts.filter(
      (a) => a.app === 'blabber' && (handle === undefined || a.handle === handle)
    );
    return { rows: matches.slice(0, limit), nextCursor: null };
  },
  /**
   * Handle/display-name autocomplete for the Search app's Accounts segment — every app's
   * identity lives in this one table (AGENTS.md §10), so this is an `accounts` route
   * (`searchAccounts` → `accounts:search`) rather than a `blabber:*` service action, even
   * though Blabber is the only caller today. A named row rather than the generic service
   * route because Blabber is an add-on: the sandbox refuses a foreign service namespace, so
   * this is read through `useAccounts().searchAccounts`. Keyset-paged like every other reader
   * here, `citizenid` withheld by construction: the fixture rows never carried one.
   */
  'accounts:search': ({
    app,
    q,
    cursor,
    limit = 30
  }: {
    app: string;
    q: string;
    cursor?: number;
    limit?: number;
  }) => {
    const needle = q.toLowerCase();
    const visible = mockAccounts
      .filter(
        (a) =>
          a.app === app &&
          a.status === 'active' &&
          (a.handle.toLowerCase().includes(needle) ||
            (a.display_name ?? '').toLowerCase().includes(needle)) &&
          (cursor === undefined || a.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },

  /**
   * The follow graph. Starts empty on purpose.
   *
   * A fixture with follows already in it would show a populated Following feed on a phone that
   * has never followed anybody, which hides the empty state — the screen a real player sees
   * first, and the one most likely to be wrong.
   */
  'accounts:follow': ({
    follower_account_id,
    followee_account_id
  }: {
    follower_account_id: number;
    followee_account_id: number;
  }) => {
    // The wire shape a real refusal has since MICA-216: the English plus a catalog key,
    // which `fetchNui` resolves in the phone's language. Returned, not thrown, because a
    // thrown Error has no key — and this is the mock's one proof that the key path works.
    if (follower_account_id === followee_account_id) {
      return { error: 'You cannot follow yourself.', key: 'server.accounts.cannotFollowSelf' };
    }
    if (!mockOwnedAccountIds.has(follower_account_id)) {
      throw new Error('That account is not yours.');
    }
    // Idempotent, as the unique index makes the server's insert. A duplicate is success.
    if (
      !mockFollows.some(
        (f) => f.follower === follower_account_id && f.followee === followee_account_id
      )
    ) {
      mockFollows.push({ follower: follower_account_id, followee: followee_account_id });
    }
    return true;
  },
  'accounts:unfollow': ({
    follower_account_id,
    followee_account_id
  }: {
    follower_account_id: number;
    followee_account_id: number;
  }) => {
    if (!mockOwnedAccountIds.has(follower_account_id)) {
      throw new Error('That account is not yours.');
    }
    const at = mockFollows.findIndex(
      (f) => f.follower === follower_account_id && f.followee === followee_account_id
    );
    if (at >= 0) mockFollows.splice(at, 1);
    return true;
  },
  'accounts:block': ({
    blocker_account_id,
    blocked_account_id
  }: {
    blocker_account_id: number;
    blocked_account_id: number;
  }) => {
    if (blocker_account_id === blocked_account_id) {
      return { error: 'You cannot block yourself.', key: 'server.accounts.cannotBlockSelf' };
    }
    if (!mockOwnedAccountIds.has(blocker_account_id)) {
      throw new Error('That account is not yours.');
    }
    if (
      !mockBlocks.some((b) => b.blocker === blocker_account_id && b.blocked === blocked_account_id)
    ) {
      mockBlocks.push({ blocker: blocker_account_id, blocked: blocked_account_id });
    }
    // Cascade-remove any follow row between the two, both directions — matching the server.
    for (let i = mockFollows.length - 1; i >= 0; i--) {
      const f = mockFollows[i];
      if (
        (f.follower === blocker_account_id && f.followee === blocked_account_id) ||
        (f.follower === blocked_account_id && f.followee === blocker_account_id)
      ) {
        mockFollows.splice(i, 1);
      }
    }
    return true;
  },
  'accounts:unblock': ({
    blocker_account_id,
    blocked_account_id
  }: {
    blocker_account_id: number;
    blocked_account_id: number;
  }) => {
    if (!mockOwnedAccountIds.has(blocker_account_id)) {
      throw new Error('That account is not yours.');
    }
    const at = mockBlocks.findIndex(
      (b) => b.blocker === blocker_account_id && b.blocked === blocked_account_id
    );
    if (at >= 0) mockBlocks.splice(at, 1);
    return true;
  },
  /**
   * The two lists behind the counts, paged the way the server pages them: on the **follow row's**
   * position, most-recently-followed first, not on the account id. `mockFollows` is append-only, so
   * its reversed index is that order — matching it here is what makes a dev-mode list arrive in the
   * same order as a real one rather than in whatever order the fixture happens to hold.
   *
   * `nextCursor` is an index into that reversed order rather than a row id, because these fixtures
   * have no follow-row ids to hand. It is opaque to the client either way — the store only ever
   * hands it back — which is the property that lets a mock differ here at all.
   */
  'accounts:followers': ({ account_id, cursor, limit = 30 }: FollowListArgs) =>
    mockFollowPage(
      mockFollows.filter((f) => f.followee === account_id).map((f) => f.follower),
      cursor,
      limit
    ),
  'accounts:following': ({ account_id, cursor, limit = 30 }: FollowListArgs) =>
    mockFollowPage(
      mockFollows.filter((f) => f.follower === account_id).map((f) => f.followee),
      cursor,
      limit
    ),
  'accounts:follows': ({
    account_id,
    viewer_account_id
  }: {
    account_id: number;
    viewer_account_id?: number;
  }) => ({
    followers: mockFollows.filter((f) => f.followee === account_id).length,
    following: mockFollows.filter((f) => f.follower === account_id).length,
    // Only for an account the viewer owns, matching the server — an unowned viewer answers false
    // rather than erroring, because reading a profile is not a privileged act.
    followedByMe:
      viewer_account_id !== undefined &&
      mockOwnedAccountIds.has(viewer_account_id) &&
      mockFollows.some((f) => f.follower === viewer_account_id && f.followee === account_id),
    blockedByMe:
      viewer_account_id !== undefined &&
      mockOwnedAccountIds.has(viewer_account_id) &&
      mockBlocks.some((b) => b.blocker === viewer_account_id && b.blocked === account_id)
  }),

  /**
   * Reactions, on any target table — DM messages today. `mockReactions` holds every row this
   * session has created, keyed by the same `(account_id, target_table, target_id, emoji)` tuple
   * the server's unique index enforces.
   */
  'accounts:react': ({
    account_id,
    target_table,
    target_id,
    emoji
  }: {
    account_id: number;
    target_table: string;
    target_id: number;
    emoji: string;
  }) => {
    if (!mockOwnedAccountIds.has(account_id)) throw new Error('That account is not yours.');
    if (
      !mockReactions.some(
        (r) =>
          r.account === account_id &&
          r.table === target_table &&
          r.target === target_id &&
          r.emoji === emoji
      )
    ) {
      mockReactions.push({ account: account_id, table: target_table, target: target_id, emoji });
    }
    return true;
  },
  'accounts:unreact': ({
    account_id,
    target_table,
    target_id,
    emoji
  }: {
    account_id: number;
    target_table: string;
    target_id: number;
    emoji: string;
  }) => {
    if (!mockOwnedAccountIds.has(account_id)) throw new Error('That account is not yours.');
    const at = mockReactions.findIndex(
      (r) =>
        r.account === account_id &&
        r.table === target_table &&
        r.target === target_id &&
        r.emoji === emoji
    );
    if (at >= 0) mockReactions.splice(at, 1);
    return true;
  },
  'accounts:reactionsFor': ({
    target_table,
    target_ids
  }: {
    target_table: string;
    target_ids: number[];
  }) => {
    const out: Record<number, { counts: Record<string, number>; mine: string[] }> = {};
    for (const id of target_ids) out[id] = { counts: {}, mine: [] };
    for (const row of mockReactions) {
      if (row.table !== target_table || !(row.target in out)) continue;
      out[row.target].counts[row.emoji] = (out[row.target].counts[row.emoji] ?? 0) + 1;
      // The mock's single active account, matching every other "mine" fixture here.
      if (row.account === 1) out[row.target].mine.push(row.emoji);
    }
    return out;
  }
};
