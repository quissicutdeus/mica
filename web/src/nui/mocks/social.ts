// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Account, Blab } from '@mica/shared/types';
import { startFresh } from './shared';

/**
 * The account graph and the Blab feed, shared by `services/accounts.ts`,
 * `services/blabber.ts`, `services/blabber_dms.ts` and `services/notifications.ts`
 * (MICA-323).
 *
 * Mutable state rather than fixtures: an account claimed, a follow, a block or a Blab
 * posted through one service is what the others read back, exactly as the server's
 * `mica_accounts` family of tables is one store behind several services.
 */

/**
 * Blabber's mock state: three accounts — two the player owns, one they do not — and a short feed.
 *
 * Hand-written rather than through `defineMockCrud`, because the feed is a **paged public**
 * read and answers `{ rows, nextCursor }`. A mock that returned a bare array would let the app
 * look fine in `pnpm dev` while being wrong against the real server — the exact failure mode
 * the route table exists to outlaw.
 */
export const mockAccounts: Account[] = [
  {
    id: 1,
    app: 'blabber',
    handle: 'ada',
    display_name: 'Ada',
    status: 'active',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z'
  },
  {
    id: 2,
    app: 'blabber',
    handle: 'nightowl',
    display_name: 'Night Owl',
    status: 'active',
    created_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z'
  },
  {
    id: 4,
    app: 'blabber',
    handle: 'ada_alt',
    display_name: null,
    status: 'active',
    created_at: '2026-08-03T10:00:00Z',
    updated_at: '2026-08-03T10:00:00Z'
  }
];

/**
 * Which of those the player owns.
 *
 * The mock had no notion of ownership at all — `getMyAccounts` filtered by `app` alone, so every
 * account in the fixture came back as the player's. Two consequences, both invisible in the
 * browser: every profile rendered as your own, and the DM fixture had @nightowl messaging an
 * account it supposedly *was*. The server has always answered this from `citizenid`, so a mock
 * that cannot say no is a mock that hides whatever depends on the answer.
 *
 * Two owned accounts rather than one, because switching identity needs something to switch to,
 * and two of a cap of three leaves room to claim another.
 */
export const mockOwnedAccountIds = new Set<number>(startFresh ? [] : [1, 4]);

export const mockBlabs: Blab[] = [
  {
    id: 3,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'traffic on the interstate is unreal today #losangeles',
    reply_to: null,
    root_id: null,
    status: 'active',
    // Relative, not a fixed date, and deliberately so: `blabber:trending_tags` windows to the
    // last 48 hours (matching the real server), so a fixed timestamp goes stale the moment the
    // suite runs more than 48 hours after it was written — exactly what happened here once. This
    // is the one fixture a tag needs to stay live in, so it needs to stay inside the window on
    // every run rather than just the run it was written on. Same pattern as the notification
    // fixtures in `services/notifications.ts`.
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  },
  {
    id: 2,
    account_id: 2,
    handle: 'nightowl',
    display_name: 'Night Owl',
    body: 'anyone up? @ada',
    reply_to: null,
    root_id: null,
    status: 'active',
    created_at: '2026-08-02T11:00:00Z',
    updated_at: '2026-08-02T11:00:00Z'
  },
  {
    id: 1,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'first',
    reply_to: null,
    root_id: null,
    status: 'active',
    created_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z'
  },
  // A reply, and a reply to that reply — replies nest through the same column, so a thread is
  // the same read one level deeper. `root_id` is set the way the server sets it at create: from
  // the parent's own `root_id` when the parent is itself a reply, never by walking the chain at
  // read time — so both descend from id 1, "first", not from their immediate parent.
  {
    id: 4,
    account_id: 2,
    handle: 'nightowl',
    display_name: 'Night Owl',
    body: 'congratulations on being first',
    reply_to: 1,
    root_id: 1,
    status: 'active',
    created_at: '2026-08-02T10:05:00Z',
    updated_at: '2026-08-02T10:05:00Z'
  },
  {
    id: 5,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'thank you',
    reply_to: 4,
    root_id: 1,
    status: 'active',
    created_at: '2026-08-02T10:06:00Z',
    updated_at: '2026-08-02T10:06:00Z'
  }
];

/**
 * The follow graph, empty to begin with.
 *
 * Account-to-account, with no citizenid, exactly as the table is: every `mica_accounts` row
 * carries an `app`, so a row can only link two accounts in the same one.
 */
export const mockFollows: { follower: number; followee: number }[] = [];
export const mockBlocks: { blocker: number; blocked: number }[] = [];
