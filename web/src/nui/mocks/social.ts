// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Account,
  Blab,
  DirectMessage,
  GlimpseComment,
  GlimpsePost,
  MediaItem,
  MediaPreview
} from '@mica/shared/types';
import { mockMedia } from './data';
import { startFresh } from './shared';

/**
 * The account graph, the Blab feed and the Glimpse grid, shared by `services/accounts.ts`,
 * `services/blabber.ts`, `services/dms.ts`, `services/glimpse.ts`,
 * `services/glimpse_comments.ts` and `services/notifications.ts` (MICA-323).
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
function sparkAccount(id: number, display_name: string): Account {
  return {
    id,
    app: 'spark',
    handle: `spark_${id}`,
    display_name,
    status: 'active',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z'
  };
}

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
  },
  // Glimpse's identities (MICA-253). The same table, a different `app`, so a handle is
  // unique within each and `ada` can be claimed in both — handles are per app by decision,
  // and a fixture that reused none would never show that.
  {
    id: 20,
    app: 'glimpse',
    handle: 'ada',
    display_name: 'Ada',
    status: 'active',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z'
  },
  {
    id: 21,
    app: 'glimpse',
    handle: 'lens_lena',
    display_name: 'Lena',
    status: 'active',
    created_at: '2026-09-02T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z'
  },
  {
    id: 22,
    app: 'glimpse',
    handle: 'nightowl',
    display_name: 'Night Owl',
    status: 'active',
    created_at: '2026-09-03T10:00:00Z',
    updated_at: '2026-09-03T10:00:00Z'
  },
  // Spark's (MICA-255): one account per citizen, made by the server and never listed, so the
  // handle is a placeholder no screen shows. The player's is 30; `mocks/spark.ts` holds the
  // profiles, and which of these liked or was blocked by whom.
  sparkAccount(30, 'Ada'),
  sparkAccount(31, 'Maya'),
  sparkAccount(32, 'Jordan'),
  sparkAccount(33, 'Casey')
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
 * and two of a cap of three leaves room to claim another. One in Glimpse, @ada (20), so its
 * feed has an owner to remove a comment as, and the Spark account (30), which exists before a
 * profile does; `?state=fresh` owns none, which is the claim gate, and Spark's `save` takes 30.
 */
export const mockOwnedAccountIds = new Set<number>(startFresh ? [] : [1, 4, 20, 30]);

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

/**
 * Reactions on any target table, keyed by the `(account_id, target_table, target_id, emoji)`
 * tuple the server's unique index enforces. Here rather than in `services/accounts.ts` so a
 * fixture can seed the ❤️ a Glimpse post arrives with; Blabber's DMs still start with none.
 */
export const mockReactions: { account: number; table: string; target: number; emoji: string }[] =
  [];

/**
 * What a public read carries of a media row: `MediaPreview`, never the `MediaItem` with its
 * uploader's `citizenid`. Blabber's mock echoes the whole row; this one projects, because the
 * projection is the thing a Glimpse spec should be able to see the server doing.
 */
export const toMediaPreview = ({
  id,
  kind,
  data,
  url,
  thumbnail,
  mime_type,
  duration_ms,
  alt_text
}: MediaItem): MediaPreview => ({
  id,
  kind,
  data,
  url,
  thumbnail,
  mime_type,
  duration_ms,
  alt_text
});

/** The gallery's live photos, the only thing a Glimpse post may carry. */
const glimpsePhotos = mockMedia.filter((m) => m.kind === 'photo' && m.status === 'active');

const glimpseAuthor = (accountId: number) => {
  const account = mockAccounts.find((a) => a.id === accountId);
  return {
    handle: account?.handle,
    display_name: account?.display_name ?? null,
    avatar: account?.avatar ?? null
  };
};

/** Who posts each of the twelve, oldest first: a mix, so a profile grid is not the whole feed. */
const GLIMPSE_AUTHORS = [21, 20, 22, 21, 21, 20, 22, 21, 20, 22, 21, 20];
const GLIMPSE_CAPTIONS = [
  'golden hour over vinewood',
  null,
  'night shift views',
  'the pier never gets old',
  'found this mural downtown @ada',
  'new ride',
  null,
  'storm rolling in over sandy shores',
  'coffee first',
  'city lights from the observatory',
  'beach day',
  'sunday drive up the coast'
];

/**
 * Twelve posts, ids 1-12 and newest last, so the feed's first page (`id DESC`) is all of them
 * and opens on 12. Every third carries a second photo and every sixth a third, so the carousel
 * has something to page through; the photos are the gallery's own, cycled.
 */
export const mockGlimpsePosts: GlimpsePost[] = GLIMPSE_AUTHORS.map((accountId, index) => {
  const id = index + 1;
  const count = 1 + (id % 3 === 0 ? 1 : 0) + (id % 6 === 0 ? 1 : 0);
  const at = new Date(Date.UTC(2026, 8, 10 + index, 12)).toISOString();
  return {
    id,
    account_id: accountId,
    caption: GLIMPSE_CAPTIONS[index],
    status: 'active',
    created_at: at,
    updated_at: at,
    ...glimpseAuthor(accountId),
    attachments: Array.from({ length: count }, (_, n) => ({
      id: id * 10 + n,
      media: toMediaPreview(glimpsePhotos[(index * 3 + n) % glimpsePhotos.length])
    }))
  };
});

const glimpseComment = (
  id: number,
  post_id: number,
  account_id: number,
  body: string
): GlimpseComment => {
  const at = new Date(Date.UTC(2026, 8, 25, 12, id)).toISOString();
  return {
    id,
    post_id,
    account_id,
    body,
    status: 'active',
    created_at: at,
    updated_at: at,
    ...glimpseAuthor(account_id)
  };
};

/**
 * A few comments. Post 12 is the player's (@ada, 20) and holds one by @lens_lena, so the
 * owner's remove-a-comment-they-did-not-write path has a row to act on without setup.
 */
export const mockGlimpseComments: GlimpseComment[] = [
  glimpseComment(1, 12, 21, 'love this road'),
  glimpseComment(2, 12, 22, 'where is this?'),
  glimpseComment(3, 11, 20, 'so jealous'),
  glimpseComment(4, 10, 21, 'great shot @nightowl'),
  glimpseComment(5, 5, 20, 'thanks for the tag!')
];

/** ❤️ on a handful of posts — post 12 by both others, post 11 by the player. */
mockReactions.push(
  { account: 21, table: 'mica_glimpse', target: 12, emoji: '❤️' },
  { account: 22, table: 'mica_glimpse', target: 12, emoji: '❤️' },
  { account: 20, table: 'mica_glimpse', target: 11, emoji: '❤️' },
  { account: 22, table: 'mica_glimpse', target: 10, emoji: '❤️' },
  { account: 21, table: 'mica_glimpse', target: 6, emoji: '❤️' }
);

/**
 * Direct messages for every app with a policy (MICA-390), here rather than in `services/dms.ts`
 * so Spark's mock can leave the seeded opener in a thread when a match is made.
 */
export const mockDms: DirectMessage[] = [
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
export const nextMockDmId = (): number => nextDmId++;
