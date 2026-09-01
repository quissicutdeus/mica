// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { taggedTopics } from '@gphone/shared/richText';
import { GENERIC_SERVICE_ACTION } from '@gphone/shared/rpc';
// Type-only: `services/bank.ts` imports `fetchNui`, which imports this file's own
// transport — a value import here would be a real import cycle, a type-only one is
// erased before anything runs.
import type { SendMoneyOutcome } from '@gphone/sdk';
import type {
  Account,
  Blab,
  BlabberDm,
  Contact,
  Conversation,
  Listing,
  Mail,
  MediaItem,
  Message,
  Note,
  NotificationItem,
  PhoneCallLogEntry,
  Report,
  SavedPlace,
  Transaction
} from '@gphone/shared/types';
import {
  mockContacts,
  mockConversations,
  mockEmails,
  mockHodlrBuyPrice,
  mockHodlrHolding,
  mockHodlrPrice,
  mockHodlrPriceHistory,
  mockHodlrSellPrice,
  mockListings,
  mockLocationShare,
  mockMedia,
  mockMessages,
  mockNotes,
  mockSavedPlaces,
  sampleAvatars
} from './data';
import { defineMockCrud } from './defineMockCrud';

// Helper to simulate delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Deliberately `any`: each handler in `mockRegistry` below declares its own,
// more specific payload shape than this container type — arrow-function
// object properties get strict (non-bivariant) parameter checking in
// TypeScript, so `unknown` here would reject every handler whose declared
// parameter isn't itself `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
export type MockHandler<T = any> = (data?: any) => Promise<T> | T;

let mockPhotoIndex = 5;

const mockReports: Report[] = [
  {
    id: 1,
    citizenid: 'REPORTER',
    target_table: 'gphone_messages',
    target_id: 4,
    category: 'harassment',
    note: 'Kept messaging after I asked them to stop.',
    resolution: 'pending',
    target_preview: 'you are going to regret that',
    target_author: 'AUTHOR1',
    status: 'active',
    created_at: '2026-07-30T10:00:00Z',
    updated_at: '2026-07-30T10:00:00Z'
  }
];

/**
 * Every row here names a fixture that exists and points at its real id.
 *
 * They did not. The titles were invented in isolation — "Sarah Connor", "Mike Ross",
 * "Boss" — while the links read `conversationId=1..3`, which are Ursula, the Union
 * Depository crew and Trevor Philips. So tapping Sarah Connor opened a conversation with
 * a stranger, and `mailId=5`/`6` named mail that does not exist at all, leaving Mail on
 * the inbox forever because `useDeepLink` returns false and is retried.
 *
 * That is not a cosmetic fixture problem. §8's whole point about mocks is that they make
 * a missing layer invisible; a mock whose ids do not resolve does the opposite and makes
 * a *working* layer look broken. Either way you cannot trust `pnpm dev`. When adding a
 * notification here, take the title and the id from the fixture it points at.
 *
 * The shapes match what the server pushes — `Email from <sender>` with the subject as the
 * body is exactly `server/services/Mail.ts`.
 */
/**
 * The mock settings table, keyed `<app>:<key>` exactly as the real unique index is.
 *
 * Module scope, so it survives between `fetchNui` calls within a page but not across a
 * reload — which is the same lifetime the real table has relative to a character session,
 * and enough for an e2e to prove a write reached "the server" rather than only
 * localStorage.
 */
const mockSettings = new Map<string, string>();

/** The lock screen's passcode (MICA-60) — `null` until `setPasscode` is called. */
let mockPasscodeValue: string | null = null;

/**
 * `mockNotifications` itself is declared further down, after `mockBlabs` — a mention
 * notification needs a real Blab to point at, and this comment's own rule ("take the title
 * and the id from the fixture it points at") is enforced by deriving from that fixture
 * rather than retyping it.
 */

/**
 * Blabber's mock state: three accounts — two the player owns, one they do not — and a short feed.
 *
 * Hand-written rather than through `defineMockCrud`, because the feed is a **paged public**
 * read and answers `{ rows, nextCursor }`. A mock that returned a bare array would let the app
 * look fine in `pnpm dev` while being wrong against the real server — the exact failure mode
 * the route table exists to outlaw.
 */
const mockAccounts: Account[] = [
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
 * `?state=fresh` presents the phone as never used before.
 *
 * Without it the first-run experience was **unreachable in the browser**: the fixtures always hold
 * data, so Blabber's claim gate — the screen that asks for your first handle, and the only thing a
 * new player sees — never rendered in `pnpm dev` or under Playwright. A path no developer can look
 * at is a path that rots, and this one is every player's first impression.
 *
 * **One axis, not a list of app ids.** This began as `?fresh=blabber`, which made the ordinary
 * invocation repeat the id it had just handed `?app=` — `?app=blabber&fresh=blabber` — to buy
 * per-app independence nothing asked for. Whether the data is fresh is orthogonal to which app you
 * open, so it reads as `?app=blabber&state=fresh`. An app that later grows its own notion of prior
 * use reads the same flag and needs no entry anywhere.
 *
 * **Not the default for `?app=`, deliberately.** Opening an app to look at a populated feed is the
 * ordinary case — every other spec in `e2e/apps/` needs one — so a deep link that always started
 * empty would take away the thing the harness is mostly for.
 *
 * Dev-only in the sense that nothing in the game supplies a query string.
 */
const startFresh =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('state')) === 'fresh';

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
const mockOwnedAccountIds = new Set<number>(startFresh ? [] : [1, 4]);

/**
 * `?bluetoothNearby=N` simulates N other Bluetooth-visible players in range.
 *
 * There is no "who is nearby" concept to mock against — there are no other players in the
 * browser at all — so this is the axis that makes both outcomes (delivered to someone /
 * nobody in range) reachable in `pnpm dev` and in Playwright. Defaults to 0 rather than a
 * plausible-looking number, same reasoning `startFresh` documents above: a mock that
 * always succeeds hides the empty-range path from anything that doesn't think to ask for
 * the other one.
 */
const bluetoothNearbyCount =
  (typeof window === 'undefined'
    ? null
    : Number(new URLSearchParams(window.location.search).get('bluetoothNearby'))) || 0;

const mockBlabs: Blab[] = [
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
    // fixtures above.
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
 * Hashtags per Blab, seeded from the real tokenizer so this fixture cannot say a tag exists
 * that the actual server-side indexer would not have extracted from the same body. `blabber:by_tag`,
 * `blabber:search_tags` and `blabber:trending_tags` all read this rather than re-scanning bodies —
 * mirroring `gphone_blabber_tags`, the child table the server writes at create time.
 */
const mockBlabTags = new Map<number, string[]>(
  mockBlabs.map((b) => [b.id, taggedTopics(b.body ?? '')])
);

const mockEars: { blab_id: number; account_id: number }[] = [{ blab_id: 1, account_id: 2 }];

/**
 * Notification previews are derived from the fixture they link to, not typed out by hand a
 * second time. `body` used to be an invented paraphrase — "GET DOWN HERE. NOW." for Trevor,
 * a line that appears nowhere in his actual thread — so the shade showed one message and
 * opening the conversation showed the real last message underneath it. Deriving from
 * `mockConversations`/`mockEmails`/`mockBlabs` means the two views can't disagree, the same
 * way `Email from <sender>` already matched `server/services/Mail.ts` by construction.
 */
const messageNotification = (
  id: number,
  conversationId: number,
  ageMs: number
): NotificationItem => {
  const conv = mockConversations.find((c) => c.id === conversationId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'messages',
    kind: 'info',
    title: conv?.name ?? 'Messages',
    body: conv?.last_message?.message ?? '',
    avatar: null,
    deep_link: `messages?conversationId=${conversationId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

const mailNotification = (id: number, mailId: number, ageMs: number): NotificationItem => {
  const mail = mockEmails.find((m) => m.id === mailId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'mail',
    kind: 'email',
    title: `Email from ${mail?.sender ?? 'Mail'}`,
    body: mail?.subject ?? '',
    avatar: null,
    deep_link: `mail?mailId=${mailId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

/** `blabId` must name a Blab that actually mentions the player, not merely one that exists. */
const mentionNotification = (id: number, blabId: number, ageMs: number): NotificationItem => {
  const blab = mockBlabs.find((b) => b.id === blabId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'blabber',
    kind: 'mention',
    title: `@${blab?.handle ?? 'someone'} mentioned you`,
    body: blab?.body ?? '',
    avatar: null,
    deep_link: `blabber?blabId=${blabId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

const mockNotifications: NotificationItem[] = [
  {
    id: 1,
    citizenid: 'mock_citizenid',
    app: 'settings',
    kind: 'info',
    title: 'Developer Tools',
    body: 'Developer Tools unlocked successfully.',
    avatar: null,
    deep_link: 'settings',
    read_at: null,
    cleared_at: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
    updated_at: new Date(Date.now() - 60000).toISOString()
  },
  // Blab 2 ("anyone up? @ada") is the one post in the fixture that actually mentions @ada,
  // one of the two accounts the player owns (`mockOwnedAccountIds`) — a mention notification
  // has to point at a mention, not merely a post that exists. It also exercises the per-app
  // filter and the deep link an in-app notifications tab reads.
  mentionNotification(7, 2, 90000),
  messageNotification(2, 1, 120000),
  messageNotification(3, 3, 300000),
  messageNotification(4, 4, 600000),
  mailNotification(5, 1, 900000),
  mailNotification(6, 2, 1200000)
];

/**
 * The follow graph, empty to begin with.
 *
 * Account-to-account, with no citizenid, exactly as the table is: every `gphone_accounts` row
 * carries an `app`, so a row can only link two accounts in the same one.
 */
/** Mutated by `sendMoney` below, so a browser session sees its own transfer reflected. */
let mockBankBalance = 12450;
const mockBankTransactions: Transaction[] = [
  {
    id: 'mock-1',
    title: 'Store',
    message: 'Store Purchase',
    amount: 45,
    direction: 'out',
    time: Math.floor(Date.now() / 1000)
  },
  {
    id: 'mock-2',
    title: 'Job',
    message: 'Salary',
    amount: 1500,
    direction: 'in',
    time: Math.floor(Date.now() / 1000) - 86400
  },
  {
    id: 'mock-3',
    title: 'Transfer',
    message: 'Transfer',
    amount: 200,
    direction: 'out',
    time: Math.floor(Date.now() / 1000) - 172800
  }
];

/**
 * The one call in flight, if any. `connectedAt` is null while it's still ringing — set
 * the moment `startCall`'s ring timer decides the other party picked up, and read back
 * by `endCall` to compute a real duration rather than always logging 0.
 */
let activeCall: {
  kind: 'incoming' | 'outgoing';
  number: string;
  connectedAt: number | null;
} | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let nextCallLogId = 100;

/**
 * Nobody is ever home at this number — the one deterministic way to exercise a missed
 * call. No hyphen: the Phone app's keypad only ever produces digits, so this has to be
 * dialable by clicking '0' seven times.
 */
const NEVER_ANSWERS = '0000000';
const RING_MS = 350;

const logCall = (kind: PhoneCallLogEntry['kind'], number: string, duration: number): void => {
  const now = new Date().toISOString();
  mockCallLog.unshift({
    id: nextCallLogId++,
    citizenid: 'mock_citizenid',
    kind,
    number,
    duration,
    created_at: now,
    updated_at: now
  });
};

const postCallStatus = (status: 'connected' | 'idle'): void => {
  window.postMessage({ action: 'callStatus', data: { status } }, '*');
};

const mockCallLog: PhoneCallLogEntry[] = [
  {
    id: 3,
    citizenid: 'mock_citizenid',
    kind: 'missed',
    number: '555-0199',
    duration: 0,
    created_at: new Date(Date.now() - 300000).toISOString(),
    updated_at: new Date(Date.now() - 300000).toISOString()
  },
  {
    id: 2,
    citizenid: 'mock_citizenid',
    kind: 'incoming',
    number: '555-0133',
    duration: 45,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 1,
    citizenid: 'mock_citizenid',
    kind: 'outgoing',
    number: '555-0144',
    duration: 122,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString()
  }
];

const mockFollows: { follower: number; followee: number }[] = [];
const mockBlocks: { blocker: number; blocked: number }[] = [];
const mockReactions: { account: number; table: string; target: number; emoji: string }[] = [];

/**
 * Reactions on a Messages thread (MICA-143), keyed by citizenid rather than an account —
 * `gphone_messages_reactions` is its own table, not `gphone_account_reactions`, and Messages
 * has no account layer to key on instead. Separate array from `mockReactions` above for the
 * same reason: two different tables, two different identity columns.
 *
 * Seeded with two other participants' reactions on one message in "Union Depository Heist"
 * (conversation id 2, its oldest message, id 2001 — see `mockConversations` in `data.ts`), a
 * >2-person group. The Messages e2e spec's group-conversation coverage needs a count that
 * already includes reactions from someone other than the mock's own identity to assert
 * against — the question MICA-143 raised was whether an aggregated count across more than
 * one other participant reads correctly, and a fixture with zero other reactors could never
 * exercise that.
 */
const mockMessageReactions: { messageId: number; citizenid: string; emoji: string }[] = [
  { messageId: 2001, citizenid: 'group-heist-member-a', emoji: '🔥' },
  { messageId: 2001, citizenid: 'group-heist-member-b', emoji: '🔥' }
];

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

let nextDmId = 50;
let nextBlabId = 100;
let nextAccountId = 10;

/** Mirrors `gphone_max_accounts_per_app`'s default. The server is the boundary. */
const MOCK_ACCOUNT_LIMIT = 3;

const mockRegistry: Record<string, MockHandler> = {
  // Accounts. `limit` is the per-app cap the server reports from a convar — matched here
  // because a mock that omitted it would hide the Claim button in `pnpm dev` and show it
  // in game, or the reverse.
  getMyAccounts: () => ({
    rows: mockAccounts.filter((a) => a.app === 'blabber' && mockOwnedAccountIds.has(a.id)),
    limit: MOCK_ACCOUNT_LIMIT
  }),
  createAccount: ({ handle, display_name }: { handle: string; display_name?: string }) => {
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
  searchAccounts: ({
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
  followAccount: ({
    follower_account_id,
    followee_account_id
  }: {
    follower_account_id: number;
    followee_account_id: number;
  }) => {
    if (follower_account_id === followee_account_id) {
      throw new Error('You cannot follow yourself.');
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
  unfollowAccount: ({
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
  blockAccount: ({
    blocker_account_id,
    blocked_account_id
  }: {
    blocker_account_id: number;
    blocked_account_id: number;
  }) => {
    if (blocker_account_id === blocked_account_id) {
      throw new Error('You cannot block yourself.');
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
  unblockAccount: ({
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
  getFollowers: ({ account_id, cursor, limit = 30 }: FollowListArgs) =>
    mockFollowPage(
      mockFollows.filter((f) => f.followee === account_id).map((f) => f.follower),
      cursor,
      limit
    ),
  getFollowing: ({ account_id, cursor, limit = 30 }: FollowListArgs) =>
    mockFollowPage(
      mockFollows.filter((f) => f.follower === account_id).map((f) => f.followee),
      cursor,
      limit
    ),
  getFollowStats: ({
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
  reactToTarget: ({
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
  unreactToTarget: ({
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
  getReactionsFor: ({
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
  },

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
  },

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
    return listing
      ? { ...listing, contactPhone: '555-0100', isOwn: listing.citizenid === 'MOCK1' }
      : null;
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
      citizenid: 'MOCK1',
      title,
      price,
      description,
      status: 'active',
      created_at: now,
      updated_at: now,
      attachments: []
    };
    mockListings.push(created);
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
  },

  /**
   * The public feed. Keyset paging on `id DESC`, matching the server: a cursor names the last
   * row already delivered, and `nextCursor: null` means the end. `account_id` is optional and,
   * when present, filters out accounts that account has blocked — matching `feed`'s server-side
   * `NOT IN` subquery.
   */
  'blabber:feed': ({
    account_id,
    cursor,
    limit = 30
  }: { account_id?: number; cursor?: number; limit?: number } = {}) => {
    const blocked =
      account_id !== undefined
        ? new Set(mockBlocks.filter((b) => b.blocker === account_id).map((b) => b.blocked))
        : null;
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.reply_to == null &&
          !(blocked && blocked.has(b.account_id)) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * The Following feed: top-level Blabs by accounts this account follows, minus accounts it has
   * blocked.
   *
   * Paged the same way as every other read here — `id DESC`, cursor is the last id delivered,
   * `nextCursor: null` is the end. A mock that answered a bare array would let the app look right
   * in `pnpm dev` while being wrong against the real server.
   */
  'blabber:following': ({
    account_id,
    cursor,
    limit = 30
  }: {
    account_id: number;
    cursor?: number;
    limit?: number;
  }) => {
    if (!mockOwnedAccountIds.has(account_id)) throw new Error('That account is not yours.');
    const followed = new Set(
      mockFollows.filter((f) => f.follower === account_id).map((f) => f.followee)
    );
    const blocked = new Set(
      mockBlocks.filter((b) => b.blocker === account_id).map((b) => b.blocked)
    );
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.reply_to == null &&
          followed.has(b.account_id) &&
          !blocked.has(b.account_id) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:create': ({
    account_id,
    body,
    reply_to,
    mouth_of,
    attachments
  }: Partial<Blab> & { attachments?: { photo_id: number }[] }) => {
    // Ownership, not mere existence — this is `ownedAccount` on the server, and the message was
    // already claiming it while the check only asked whether the row existed at all.
    const account = mockAccounts.find((a) => a.id === account_id && mockOwnedAccountIds.has(a.id));
    if (!account) throw new Error('That account is not yours to post from.');
    // Inherited from the parent's own `root_id`, never walked at read time — the parent is either
    // top-level (`root_id` null, so it becomes the root) or itself a reply (`root_id` already the
    // true top-level ancestor), exactly as the server computes it at create.
    const replyParent = reply_to != null ? mockBlabs.find((b) => b.id === reply_to) : undefined;
    const rootId = replyParent ? (replyParent.root_id ?? replyParent.id) : null;
    // The real server resolves a bare `photo_id` back to a full media row before it ever
    // reaches the client (`resolveOwnedAttachments` then `findAttachmentsFor`) — a mock that
    // echoed the id alone would render a blank thumbnail while the server rendered a real one.
    const resolvedAttachments = (attachments ?? [])
      .map((att, i) => {
        const photo = mockMedia.find((p) => p.id === att.photo_id);
        return photo ? { id: i, media: photo } : null;
      })
      .filter((att): att is { id: number; media: (typeof mockMedia)[number] } => att !== null);
    const created: Blab = {
      id: nextBlabId++,
      account_id: account.id,
      // Hydrated exactly as the server's echo is, avatar and quoted Blab included. The client
      // prepends this row straight into the feed and no longer grafts the mouthed target on
      // itself, so a mock that omitted `mouthed` would render an empty quote card in the browser
      // while the real server rendered a full one — the mock disagreeing with the server is the
      // failure this file exists to avoid.
      handle: account.handle,
      display_name: account.display_name,
      avatar: account.avatar ?? null,
      body: body ?? null,
      reply_to: reply_to ?? null,
      root_id: rootId,
      mouth_of: mouth_of ?? null,
      mouthed:
        mouth_of == null
          ? null
          : (mockBlabs.find((b) => b.id === mouth_of && b.status === 'active') ?? null),
      attachments: resolvedAttachments,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockBlabs.unshift(created);
    // Indexed at create, matching `gphone_blabber_tags` — otherwise a Blab posted in the browser
    // would never surface from a tag tap or trending chip added in this same session.
    mockBlabTags.set(created.id, taggedTopics(created.body ?? ''));
    return { ...created, editWindow: 900 };
  },
  'blabber:update': ({ id, body }: { id: number; body: string }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.body = body;
    return true;
  },
  'blabber:engagement': ({ ids = [] }: { ids?: number[] } = {}) => {
    const out: Record<number, unknown> = {};
    for (const id of ids) {
      out[id] = {
        replies: mockBlabs.filter((b) => b.reply_to === id && b.status === 'active').length,
        mouths: mockBlabs.filter((b) => b.mouth_of === id && b.status === 'active').length,
        ears: mockEars.filter((l) => l.blab_id === id).length,
        earedByMe: mockEars.some((l) => l.blab_id === id && l.account_id === 1),
        mouthedByMe: mockBlabs.some(
          (b) => b.mouth_of === id && b.account_id === 1 && b.status === 'active'
        )
      };
    }
    return out;
  },
  'blabber:ear': ({ blab_id }: { blab_id: number }) => {
    if (!mockEars.some((l) => l.blab_id === blab_id && l.account_id === 1)) {
      mockEars.push({ blab_id, account_id: 1 });
    }
    return true;
  },
  'blabber:unear': ({ blab_id }: { blab_id: number }) => {
    const at = mockEars.findIndex((l) => l.blab_id === blab_id && l.account_id === 1);
    if (at >= 0) mockEars.splice(at, 1);
    return true;
  },
  /**
   * The one way to open a Blab — the root of its thread, plus every reply at any depth,
   * flattened and keyset-paged. Supersedes the single-row `blabber:blab`: that mock answered
   * "what is this row," which left the app with no way to reach a reply's own top-level
   * ancestor, exactly like the real single-row read it replaced server-side.
   *
   * `anchorId` only matters on the initial open (no `cursor`) and centers the returned window on
   * that row rather than starting from the newest reply — mirroring the real server's windowed
   * query when a feed tap or notification names a specific reply to land on.
   */
  'blabber:view': ({
    id,
    cursor,
    limit = 30,
    anchorId
  }: {
    id: number;
    cursor?: number;
    limit?: number;
    anchorId?: number;
  }) => {
    const requested = mockBlabs.find((b) => b.id === id && b.status === 'active');
    if (!requested) return { root: null, replies: [], nextCursor: null };

    const rootId = requested.root_id ?? requested.id;
    const root = mockBlabs.find((b) => b.id === rootId && b.status === 'active') ?? null;
    if (!root) return { root: null, replies: [], nextCursor: null };

    const subtree = mockBlabs
      .filter((b) => b.status === 'active' && b.id !== rootId && (b.root_id ?? b.id) === rootId)
      .sort((a, b) => b.id - a.id);

    let windowed = subtree;
    if (cursor === undefined && anchorId !== undefined) {
      // Mirrors `BlabberRepository.findFlattenedPage`'s anchor branch exactly: `newer` is read
      // ascending and capped at half the page so the window centers on the anchor instead of
      // starting from the newest reply, then reversed once back to `id DESC` for the merge.
      // `older`'s cap includes the `+1` probe row `hasMore` below reads, same as the real query's
      // `LIMIT ?` with `limit - newer.length + 1`.
      //
      // Worked example, matching `subtree = [10,9,8,7,6,5,4,3,2,1]`, `anchorId = 5`, `limit = 4`:
      //   half = ceil(4/2) = 2
      //   newerAsc  = subtree>5 reversed to ASC = [6,7,8,9,10], sliced to half  -> [6,7]
      //   newerDesc = newerAsc reversed back to DESC                            -> [7,6]
      //   older     = subtree<=5, sliced to (4 - 2 + 1 = 3)                     -> [5,4,3]
      //   windowed  = [7,6,5,4,3]  -> page = windowed.slice(0,4) = [7,6,5,4], nextCursor = 4
      const half = Math.ceil(limit / 2);
      const newerAsc = subtree
        .filter((b) => b.id > anchorId)
        .slice()
        .reverse()
        .slice(0, half);
      const newerDesc = newerAsc.slice().reverse();
      const older = subtree.filter((b) => b.id <= anchorId).slice(0, limit - newerDesc.length + 1);
      windowed = [...newerDesc, ...older];
    } else if (cursor !== undefined) {
      windowed = subtree.filter((b) => b.id < cursor);
    }

    const page = windowed.slice(0, limit);
    const hasMore = windowed.length > page.length;
    return { root, replies: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:profile': ({
    account_id,
    tab,
    cursor,
    limit = 30,
    viewer_account_id
  }: {
    account_id: number;
    tab?: string;
    cursor?: number;
    limit?: number;
    viewer_account_id?: number;
  }) => {
    // One-directional, matching the server: a viewer who has blocked this account sees an
    // empty profile rather than a filtered one.
    if (
      viewer_account_id !== undefined &&
      mockBlocks.some((b) => b.blocker === viewer_account_id && b.blocked === account_id)
    ) {
      return { rows: [], nextCursor: null };
    }
    const repliesOnly = tab === 'replies';
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.account_id === account_id &&
          (repliesOnly ? b.reply_to != null : b.reply_to == null) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:delete': ({ id }: { id: number }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.status = 'deleted';
    return true;
  },
  /**
   * Body search. Unlike the feed and Following, replies are included — a search answers "what
   * was said," not "what was said at the top level" — so a matched reply opens through
   * `blabber:view` like everything else, landing on its flattened root screen.
   */
  'blabber:search': ({ q, cursor, limit = 30 }: { q: string; cursor?: number; limit?: number }) => {
    const needle = q.toLowerCase();
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          (b.body ?? '').toLowerCase().includes(needle) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * Tag-name autocomplete for the Search app's Tags segment. Not keyset-paged — a bounded
   * autocomplete list, not a feed a player scrolls to the bottom of — matching the real server.
   */
  'blabber:search_tags': ({ q }: { q: string }) => {
    const counts = new Map<string, number>();
    for (const [, tags] of mockBlabTags) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const rows = [...counts.entries()]
      .filter(([tag]) => tag.startsWith(q.toLowerCase()))
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses)
      // Matches the real query's `LIMIT 20` — a bounded dropdown, not a full ranking.
      .slice(0, 20);
    return { rows, nextCursor: null };
  },
  /**
   * Blabs carrying one exact tag — the shared landing spot for a Tags-search result, an inline
   * `#tag` tap, and a trending-chip tap. Exact match against `mockBlabTags`, never a substring:
   * `#car` must not surface `#cars` or `#carpet`.
   */
  'blabber:by_tag': ({
    tag,
    cursor,
    limit = 30
  }: {
    tag: string;
    cursor?: number;
    limit?: number;
  }) => {
    const ids = new Set(
      [...mockBlabTags.entries()].filter(([, tags]) => tags.includes(tag)).map(([id]) => id)
    );
    const visible = mockBlabs
      .filter(
        (b) => ids.has(b.id) && b.status === 'active' && (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * A bounded snapshot, not a list a player pages through — no cursor, matching the real
   * server's un-paged top-10. Recomputed per call rather than cached, so it can never drift from
   * `mockBlabTags` the way a denormalized count could.
   *
   * Windowed to the last 48 hours, matching the real server's `WHERE b.created_at > NOW() -
   * INTERVAL 48 HOUR`. Every fixture `created_at` predates that window, so — correctly, matching
   * what a real database would answer against this same data — this returns nothing until a
   * Blab is created during the session.
   */
  'blabber:trending_tags': () => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    for (const [id, tags] of mockBlabTags) {
      const blab = mockBlabs.find((b) => b.id === id && b.status === 'active');
      if (!blab || new Date(blab.created_at).getTime() <= cutoff) continue;
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 10);
  },

  // Contacts
  ...defineMockCrud<Contact>(
    mockContacts,
    {
      list: 'getContacts',
      create: 'createContact',
      update: 'updateContact',
      remove: 'deleteContact'
    },
    // MICA-75-wiring: the real server never hard-deletes a contact (`Repository.
    // delete` only ever moves `status` to `'deleted'`) — matching that here is what
    // makes a deleted-then-restored contact a real round trip in the mock, not one
    // that only works against a live server.
    { remove: 'soft', visible: (c) => c.status !== 'deleted', defaults: { status: 'active' } }
  ),
  getCallLog: () => ({ rows: mockCallLog, nextCursor: null }),
  /**
   * The real client resolves this NUI callback immediately and pushes the outcome
   * asynchronously as a toast — mirrored here via the same `appEvent` message the real
   * server push travels over, so the round trip is exercised rather than faked.
   */
  shareContact: async () => {
    const count = bluetoothNearbyCount;
    if (typeof window !== 'undefined') {
      delay(150).then(() => {
        window.postMessage(
          {
            action: 'appEvent',
            data: {
              app: 'contacts',
              event: 'share_result',
              payload: { count },
              at: Date.now(),
              notify: {
                title: count > 0 ? 'Contact shared' : 'Nobody nearby',
                message:
                  count > 0
                    ? `Shared with ${count} nearby ${count === 1 ? 'phone' : 'phones'}.`
                    : 'No Bluetooth-visible players are in range.'
              }
            }
          },
          '*'
        );
      });
    }
    return { ok: true };
  },

  // Notes
  ...defineMockCrud<Note>(
    mockNotes,
    {
      // Scoped keys, because Notes goes through the generic service route: the request
      // arrives as `{ service: 'notes', action: 'get' }` rather than as `getNotes`.
      list: 'notes:get',
      create: 'notes:create',
      update: 'notes:update',
      remove: 'notes:delete'
    },
    // MICA-75-wiring: matches the real server, which only ever soft-deletes a note.
    { remove: 'soft', visible: (n) => n.status !== 'deleted', defaults: { status: 'active' } }
  ),

  // Recently Deleted (MICA-75-wiring). Notes is `core: false`, so its two actions are
  // scoped keys (the generic service route) rather than named routes, matching the CRUD
  // block above; Contacts and Media are `core: true` and keep named routes.
  'notes:getDeleted': () => mockNotes.filter((n) => n.status === 'deleted'),
  'notes:restore': (data: { id?: number }) => {
    const note = mockNotes.find((n) => n.id === data?.id && n.status === 'deleted');
    if (!note) return { ok: false };
    note.status = 'active';
    return { ok: true };
  },
  getDeletedContacts: () => mockContacts.filter((c) => c.status === 'deleted'),
  restoreContact: (data: { id?: number }) => {
    const contact = mockContacts.find((c) => c.id === data?.id && c.status === 'deleted');
    if (!contact) return { ok: false };
    contact.status = 'active';
    return { ok: true };
  },

  // Hodlr — also routes through the generic service path, but custom actions rather
  // than the generic CRUD helper: portfolio/price are reads, buy/sell mutate state
  // that the generic four-verb shape (get/create/update/delete) cannot express.
  // `ready` is the market's own state rather than a loading flag: the server withholds the
  // quote until it has restored the price from storage after a restart (MICA-130). The
  // browser has no restart to survive, so the mock market is always open.
  // `buyPrice`/`sellPrice` (MICA-147/MICA-149) are the stand-in spread from
  // `data.ts` — `current` stays the mid/reference price the chart plots, unchanged.
  'hodlr:price': () => ({
    ready: true,
    current: mockHodlrPrice,
    buyPrice: mockHodlrBuyPrice,
    sellPrice: mockHodlrSellPrice,
    history: mockHodlrPriceHistory
  }),
  'hodlr:portfolio': () => ({
    ready: true,
    quantity: mockHodlrHolding.quantity,
    currentPrice: mockHodlrPrice,
    currentValue: mockHodlrHolding.quantity * mockHodlrPrice
  }),
  'hodlr:buy': ({ quantity }: { quantity: number }) => {
    mockHodlrHolding.quantity += quantity;
    return {
      ok: true,
      quantity: mockHodlrHolding.quantity,
      price: mockHodlrBuyPrice,
      cost: quantity * mockHodlrBuyPrice
    };
  },
  'hodlr:sell': ({ quantity }: { quantity: number }) => {
    if (mockHodlrHolding.quantity < quantity) {
      return { ok: false, reason: 'insufficient_holdings' };
    }
    mockHodlrHolding.quantity -= quantity;
    return {
      ok: true,
      quantity: mockHodlrHolding.quantity,
      price: mockHodlrSellPrice,
      proceeds: quantity * mockHodlrSellPrice
    };
  },

  // Messages
  getConversations: () => mockConversations,
  getMessages: ({ conversation_id }: { conversation_id: number }) => {
    return mockMessages[conversation_id] || [];
  },
  receiveMessage: async (payload?: { conversation_id?: number; message?: string }) => {
    const convId = payload?.conversation_id || 1;
    const msgText = payload?.message || '1... 🤬😡🗯️‼️';
    const conv = mockConversations.find((c) => c.id === convId);
    if (conv) {
      conv.unread_count = (conv.unread_count || 0) + 1;
      const newMsg: Message = {
        id: Math.floor(Math.random() * 1000000),
        conversation_id: convId,
        citizenid: (conv as Conversation & { cit?: string }).cit || 'cit-ursula',
        status: 'active',
        message: msgText,
        attachments: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      conv.last_message = newMsg;
      if (!mockMessages[convId]) mockMessages[convId] = [];
      mockMessages[convId].push(newMsg);
    }
    return true;
  },
  sendMessage: async (payload: {
    conversation_id: number;
    message: string;
    attachments?: { photo_id: number; attachment?: string }[];
  }) => {
    await delay(200);
    const convId = payload.conversation_id;
    const msg: Message = {
      id: Math.floor(Math.random() * 1000000),
      conversation_id: convId,
      citizenid: 'my-id',
      status: 'active',
      message: payload.message,
      // Hydrated the same way the real server does: `photo_id` resolves to the owning
      // row's full media, not just echoed back bare. Without this a freshly-sent
      // attachment rendered nothing until the next fetch re-hydrated it — invisible for
      // any kind a test sends and immediately asserts on, which a pre-seeded fixture
      // (already carrying `media`) never exercised.
      attachments: (payload.attachments || []).map((a, i) => ({
        ...a,
        id: i,
        media: mockMedia.find((p) => p.id === a.photo_id)
      })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (!mockMessages[convId]) {
      mockMessages[convId] = [];
    }
    mockMessages[convId].push(msg);

    const conv = mockConversations.find((c) => c.id === convId);
    if (conv) {
      conv.last_message = msg;
      conv.updated_at = msg.created_at;
    }

    return msg;
  },
  /**
   * Editing and unsending, mocked against the same fixture array the thread reads.
   *
   * Both mutate `mockMessages` rather than answering `true` and leaving the fixture alone:
   * the store applies the server's reply optimistically, so a mock that only said "fine"
   * would still look right on screen and hide a reload that disagreed with it. The
   * ownership rule is mirrored too — `citizenid !== 'my-id'` is refused here exactly as the
   * server refuses a message the caller did not send.
   */
  editMessage: async (data?: { id?: number; message?: string }) => {
    await delay(150);
    const text = (data?.message ?? '').trim();
    if (!text) throw new Error('A message needs some text. Unsend it instead of emptying it.');
    for (const list of Object.values(mockMessages)) {
      const msg = list.find((m) => m.id === data?.id);
      if (!msg) continue;
      if (msg.citizenid !== 'my-id') throw new Error('That message is not yours to change.');
      if (msg.message === text)
        return { id: msg.id, conversation_id: msg.conversation_id, message: text };
      msg.message = text;
      msg.edited = true;
      msg.updated_at = new Date().toISOString();
      return { id: msg.id, conversation_id: msg.conversation_id, message: text, edited: true };
    }
    throw new Error('That message is not yours to change.');
  },
  deleteMessage: async (data?: { id?: number }) => {
    await delay(150);
    for (const [convId, list] of Object.entries(mockMessages)) {
      const index = list.findIndex((m) => m.id === data?.id);
      if (index === -1) continue;
      if (list[index].citizenid !== 'my-id')
        throw new Error('That message is not yours to change.');
      list.splice(index, 1);
      const conv = mockConversations.find((c) => c.id === Number(convId));
      // The list preview follows the thread: unsending the newest message must not leave
      // the conversation row quoting something nobody can open any more.
      if (conv && conv.last_message?.id === data?.id) {
        conv.last_message = list[list.length - 1];
      }
      return true;
    }
    return false;
  },
  /**
   * Reactions on a message (MICA-143), the same three-verb shape as `reactToTarget`/
   * `unreactToTarget`/`getReactionsFor` above but against `mockMessageReactions` — a
   * `messages`-owned fixture keyed on citizenid, not an account. The mock's one caller
   * identity is `'my-id'`, matching `editMessage`/`deleteMessage`'s own ownership checks
   * above.
   */
  reactToMessage: ({ message_id, emoji }: { message_id: number; emoji: string }) => {
    if (
      !mockMessageReactions.some(
        (r) => r.messageId === message_id && r.citizenid === 'my-id' && r.emoji === emoji
      )
    ) {
      mockMessageReactions.push({ messageId: message_id, citizenid: 'my-id', emoji });
    }
    return true;
  },
  unreactToMessage: ({ message_id, emoji }: { message_id: number; emoji: string }) => {
    const at = mockMessageReactions.findIndex(
      (r) => r.messageId === message_id && r.citizenid === 'my-id' && r.emoji === emoji
    );
    if (at >= 0) mockMessageReactions.splice(at, 1);
    return true;
  },
  getMessageReactions: ({ target_ids }: { target_ids: number[] }) => {
    const out: Record<number, { counts: Record<string, number>; mine: string[] }> = {};
    for (const id of target_ids) out[id] = { counts: {}, mine: [] };
    for (const row of mockMessageReactions) {
      if (!(row.messageId in out)) continue;
      out[row.messageId].counts[row.emoji] = (out[row.messageId].counts[row.emoji] ?? 0) + 1;
      if (row.citizenid === 'my-id') out[row.messageId].mine.push(row.emoji);
    }
    return out;
  },
  /**
   * `is_group` is deliberately ignored, exactly as the server ignores it (MICA-153).
   * It is derived from how many people are in the thread, so a mock that echoed the
   * payload back would let the browser and every Playwright run keep the semantics the
   * game no longer has — the shape of drift AGENTS.md §8 warns a mock can hide.
   */
  startConversation: async ({ participants }: { phone?: string; participants?: string[] }) => {
    await delay(300);
    // The caller plus the target, plus anyone else named — more than two is a group.
    const members = 2 + new Set(participants ?? []).size;
    return {
      id: Math.random(),
      citizenid: 'my-id',
      is_group: members > 2,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: []
    } as Conversation;
  },
  readConversation: async (data?: number | { conversation_id?: number }) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.unread_count = 0;
      const myPart = conv.participants?.find((p) => p.citizenid === 'my-id');
      if (myPart && conv.last_message) {
        myPart.last_read = conv.last_message.created_at;
      }
    }
    return true;
  },
  archiveConversation: async (data?: { conversation_id?: number; status?: string }) => {
    await delay(200);
    // Reads `status`, which is what `store/messages.ts` actually sends. It used to read
    // `archived`, a key nothing ever set, so archiving was a silent no-op in the browser
    // and in Playwright — the route test only checks names, not payloads.
    const conv = mockConversations.find((c) => c.id === data?.conversation_id);
    if (conv && (data?.status === 'archived' || data?.status === 'active')) {
      conv.status = data.status;
    }
    return true;
  },
  deleteConversation: async (data?: number | { conversation_id?: number }) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const idx = mockConversations.findIndex((c) => c.id === id);
    if (idx !== -1) {
      mockConversations.splice(idx, 1);
    }
    return true;
  },
  renameConversation: async (data?: { id?: number; conversation_id?: number; name?: string }) => {
    await delay(200);
    const id = data?.id ?? data?.conversation_id;
    const name = data?.name;
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.name = name;
    }
    return { success: true, name };
  },

  // Account
  getCitizenId: () => 'my-id',
  getPhoneNumber: () => '867-5309',
  getBankBalance: () => mockBankBalance,
  // Shaped exactly like BankingBridge output: positive magnitudes with an explicit
  // direction. The previous mock used signed amounts, which no banking resource
  // produces — so red/green rendering worked here and was wrong in game.
  getTransactions: (): Transaction[] => mockBankTransactions,
  /**
   * Mirrors `server/services/Bank.ts`'s `sendMoney` refusal reasons, so the same UI
   * copy in `SendMoneyModal.svelte` is exercised in a browser as in game. `867-5309` is
   * this mock's own `getPhoneNumber` — dialing it is a self-transfer, same as the real
   * `same_player` check. `000-0000` is the one number nobody is ever reachable at.
   */
  sendMoney: (payload?: { phone?: string; amount?: number; note?: string }): SendMoneyOutcome => {
    const phone = typeof payload?.phone === 'string' ? payload.phone.trim() : '';
    const amount = Number(payload?.amount);

    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid_amount' };
    }
    if (amount > 50_000) {
      return { ok: false, reason: 'exceeds_limit' };
    }
    if (phone === '867-5309') {
      return { ok: false, reason: 'same_player' };
    }
    if (!phone || phone === '000-0000') {
      return { ok: false, reason: 'recipient_offline' };
    }
    if (amount > mockBankBalance) {
      return { ok: false, reason: 'insufficient_funds' };
    }

    mockBankBalance -= amount;
    mockBankTransactions.unshift({
      id: `mock-transfer-${Date.now()}`,
      title: 'Transfer',
      message: payload?.note ? `Sent to ${phone}: ${payload.note}` : `Sent to ${phone}`,
      amount,
      direction: 'out',
      time: Math.floor(Date.now() / 1000)
    });

    return { ok: true, to: phone, amount };
  },

  /**
   * Call. There is only ever one player, so `startCall` plays both ends: it rings for
   * `RING_MS`, then either connects (posting the same `callStatus` window message the
   * real client forwards from the server's `phone:accepted` push) or, for
   * `NEVER_ANSWERS`, gives up and logs a missed call — mirroring
   * `server/services/Phone.ts`'s own caller-always-outgoing, duration-0-when-unanswered
   * rule, so the same call log this mock produces is honest against what the real server
   * would have written.
   */
  startCall: (payload?: { number?: string }) => {
    const number = typeof payload?.number === 'string' ? payload.number : 'Unknown';
    if (ringTimer) clearTimeout(ringTimer);
    activeCall = { kind: 'outgoing', number, connectedAt: null };

    ringTimer = setTimeout(() => {
      if (!activeCall) return; // Hung up mid-ring — `endCall` already cleared this.
      if (number === NEVER_ANSWERS) {
        logCall('outgoing', number, 0);
        activeCall = null;
        postCallStatus('idle');
      } else {
        activeCall.connectedAt = Date.now();
        postCallStatus('connected');
      }
    }, RING_MS);

    return true;
  },
  endCall: () => {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
    if (activeCall) {
      const duration = activeCall.connectedAt
        ? Math.round((Date.now() - activeCall.connectedAt) / 1000)
        : 0;
      logCall(activeCall.kind, activeCall.number, duration);
      activeCall = null;
    }
    return true;
  },
  answerCall: () => {
    return true;
  },
  toggleMute: async () => {
    return true;
  },
  toggleSpeaker: async () => {
    return true;
  },

  // Camera & Media
  takePhoto: () => {
    const photo = sampleAvatars[mockPhotoIndex % sampleAvatars.length];
    mockPhotoIndex++;
    return photo;
  },
  flipCamera: async (data?: { isFrontCamera?: boolean }) => ({
    supported: true,
    isFrontCamera: !!data?.isFrontCamera
  }),
  // The default `gphone_camera_quality`. A browser has no convars, so answering with the
  // number the client would answer with on an unconfigured server keeps the two paths
  // encoding the same bytes.
  cameraQuality: async () => ({ quality: 95 }),
  /**
   * `gphone_addon_hosts` and `gphone_addon_catalog` (MICA-126).
   *
   * **Empty by default, because a stock server is.** A mock that helpfully returned a
   * catalog would make the dev browser the one place remote installs work, which is
   * precisely the divergence mocks are supposed not to introduce.
   *
   * The two env vars are the browser harness's stand-in for the convars, so the loop an
   * operator configures in `server.cfg` can be walked end to end without a game running:
   *
   * ```sh
   * VITE_MICA_ADDON_HOSTS=store.example.com \
   * VITE_MICA_ADDON_CATALOG=https://store.example.com/catalog.json pnpm dev
   * ```
   *
   * Unset — which is every ordinary `pnpm dev`, every Playwright run and every production
   * build — they resolve to exactly what an unconfigured client answers.
   */
  remoteAppConfig: async () => ({
    hosts: String(import.meta.env.VITE_MICA_ADDON_HOSTS ?? '')
      .split(/[\s,]+/)
      .filter(Boolean),
    catalogUrl: String(import.meta.env.VITE_MICA_ADDON_CATALOG ?? '')
  }),
  onCameraApp: async () => true,
  // Media and mail are soft-deleted, as the server does it: a removed row is still
  // there to be moderated.
  //
  // `getMedia` is overridden immediately below: `defineMockCrud` answers a list with a bare
  // array and every column, and the real read is paged and projected now (MICA-110). The
  // create and delete handlers are still exactly the generic ones.
  ...defineMockCrud<MediaItem>(
    mockMedia,
    { list: 'getMedia', create: 'createMedia', remove: 'deleteMedia' },
    {
      remove: 'soft',
      visible: (p) => p.status !== 'deleted',
      insert: 'prepend',
      defaults: { status: 'active' }
    }
  ),
  /**
   * The gallery list, paged and **without `data`** — the mock's whole job here.
   *
   * `data` is `private: true` on the service now, so the real read hands back a thumbnail
   * and metadata and nothing else. A mock that kept answering with the bytes would let the
   * grid go on drawing originals in `pnpm dev` and in Playwright while drawing placeholders
   * in game, which is §8's silent-layer failure pointing the other way.
   *
   * `data` is dropped and nothing is substituted for it, which is what makes
   * `mocks/data.ts`'s two thumbnail-less captures (950, 951) do their job: they arrive with
   * no image source at all, exactly as a photo taken before this shipped does, and that is
   * the only reason the grid's lazy hydrate-and-backfill path is reachable in a browser
   * rather than being code only the game can run.
   */
  getMedia: async ({ cursor, limit = 30 }: { cursor?: number; limit?: number } = {}) => {
    const visible = mockMedia
      .filter((p) => p.status !== 'deleted' && (cursor === undefined || p.id < cursor))
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return {
      // `delete` rather than a rest destructure, because the unused `data` binding a rest
      // destructure leaves behind is exactly what the linter is right to object to.
      rows: page.map((p) => {
        const projected = { ...p };
        delete projected.data;
        return projected;
      }),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  },
  /**
   * The only path to the `thumbnail` column, and it has two callers.
   *
   * The camera writes one at capture time, and the gallery writes one back for a row that
   * arrived without — `AddMedia`'s `thumbnail` is optional, so other resources keep creating
   * those. Neither can ride along on `createMedia`, because the column is
   * `clientWritable: false`.
   *
   * Write-once against the fixture, exactly as the server's `thumbnail IS NULL` predicate
   * is, so a replay answers `{ stored: false }` and the browser sees the same "somebody got
   * there first" outcome the game does rather than a success the game would never report.
   */
  setMediaThumbnail: async ({ id, thumbnail }: { id: number; thumbnail: string }) => {
    const row = mockMedia.find((p) => p.id === id && p.status === 'active');
    if (!row || row.thumbnail) return { stored: false };
    row.thumbnail = thumbnail;
    return { stored: true };
  },
  /** One row, bytes and all — what opening a photo, or hydrating a bare tile, asks for. */
  getMediaItem: async ({ id }: { id: number }) => {
    const row = mockMedia.find((p) => p.id === id && p.status !== 'deleted');
    if (!row) throw new Error('That photo could not be found.');
    return row;
  },
  // Bluetooth proximity drop. A named route (`shareMediaNearby`), not `defineMockCrud` —
  // no CRUD verb fits copying a row to N nearby recipients.
  shareMediaNearby: async () => {
    const count = bluetoothNearbyCount;
    if (count > 0 && typeof window !== 'undefined') {
      delay(150).then(() => {
        window.postMessage(
          {
            action: 'appEvent',
            data: {
              app: 'media',
              event: 'media_received',
              payload: {},
              at: Date.now(),
              notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
            }
          },
          '*'
        );
      });
    }
    return { count };
  },
  // Location sharing. Fixed coordinates rather than anything real — the browser has no
  // ped position to read — matching the mock's job of exercising every layer above the
  // native call, not the native call itself.
  shareLocation: async () => ({ id: mockLocationShare.id, media: mockLocationShare }),
  // Purely local in game (`SetNewWaypoint`); nothing for the browser to do but succeed.
  setWaypoint: async () => ({ ok: true }),

  // Places (MICA-65) — saved places only; recently-shared locations read `mockMedia`
  // above, filtered to `kind === 'location'`, the same way the real app will. Stands in
  // for `defineService({ id: 'places', ... })`, whose real `registerEvent` handlers
  // (Cody's server slice) exist alongside this mock now — kept for `pnpm dev`/Playwright.
  ...defineMockCrud<SavedPlace>(mockSavedPlaces, {
    list: 'getSavedPlaces',
    create: 'createSavedPlace',
    update: 'updateSavedPlace',
    remove: 'deleteSavedPlace'
  }),

  // Recently Deleted (MICA-75-wiring). Named routes, since Media is `core: true`.
  getDeletedMedia: () => mockMedia.filter((m) => m.status === 'deleted'),
  restoreMedia: (data: { id?: number }) => {
    const item = mockMedia.find((m) => m.id === data?.id && m.status === 'deleted');
    if (!item) return { ok: false };
    item.status = 'active';
    return { ok: true };
  },

  // Mail
  ...defineMockCrud<Mail>(
    mockEmails,
    { list: 'getMail', remove: 'deleteMail' },
    { remove: 'soft', visible: (e) => e.status !== 'deleted' }
  ),
  markAsRead: async (data: { id: number }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.read = true;
    return true;
  },
  archiveMail: async (data: { id: number; archive?: boolean }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.status = data.archive === false ? 'active' : 'archived';
    return true;
  },

  // Reports & moderation. Stateful, like the photo and mail mocks: resolving has to
  // actually empty the queue, or the browser cannot show what happens next and the undo
  // flow has nothing to undo.
  createReport: async () => ({ ok: true, id: 1 }),
  getReportQueue: async () => mockReports.filter((r) => r.resolution === 'pending'),
  getReportHistory: async () => mockReports.filter((r) => r.resolution !== 'pending'),
  resolveReport: async (data?: { id?: number; action?: string }) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = data?.action === 'moderate' ? 'actioned' : 'dismissed';
    return { ok: true, resolution: report?.resolution };
  },
  reopenReport: async (data?: { id?: number }) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = 'pending';
    return { ok: true, resolution: 'pending' };
  },

  // Highscores — shared leaderboard. Stateless mock: `pnpm dev` cannot stand in for a real
  // server per docs/writing-an-app.md, so this is just enough to exercise the UI.
  submitHighscore: async () => ({ ok: true }),
  getHighscoreLeaderboard: async () => [
    { citizenid: 'MOCK1', score: 42, displayName: 'Ada' },
    { citizenid: 'MOCK2', score: 17, displayName: 'Dez' }
  ],

  /**
   * Settings — the server-backed store, standing in for a real table.
   *
   * Backed by a plain Map rather than a fixture list, and it **mutates**: a mock that
   * answers a read without recording the write makes a broken sync look perfect in
   * `pnpm dev` and in Playwright, which is the exact failure `defineMockCrud` exists to
   * stop for the CRUD path.
   *
   * It is deliberately empty at start. A fresh character has written no preferences, so
   * hydration must return nothing and leave the shipped defaults standing — seeding it
   * would hide the case where hydration wrongly blanks a store.
   */
  getSettings: async () =>
    [...mockSettings.entries()].map(([composite, setting_value], index) => {
      const [app, ...rest] = composite.split(':');
      return {
        id: index + 1,
        citizenid: 'mock_citizenid',
        app,
        setting_key: rest.join(':'),
        setting_value,
        status: 'active' as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }),

  saveSetting: async (data?: { app?: string; key?: string; value?: string }) => {
    if (!data?.app || !data?.key) return false;
    mockSettings.set(`${data.app}:${data.key}`, String(data.value ?? ''));
    return true;
  },

  removeSetting: async (data?: { app?: string; key?: string }) => {
    if (!data?.app || !data?.key) return false;
    mockSettings.delete(`${data.app}:${data.key}`);
    return true;
  },

  clearAppSettings: async (data?: { app?: string }) => {
    if (!data?.app) return false;
    const prefix = `${data.app}:`;
    for (const composite of [...mockSettings.keys()]) {
      if (composite.startsWith(prefix)) mockSettings.delete(composite);
    }
    return true;
  },

  // Lock screen passcode (MICA-60). `mockPasscodeValue` stands in for a hashed column —
  // stored in plain text here only because the mock has no server to hash on, and this
  // module never persists across a reload anyway.
  // PENDING (Cody): no `registerEvent` handler exists yet for any of these four.
  getPasscodeStatus: async () => ({ hasPasscode: mockPasscodeValue !== null }),
  setPasscode: async (data?: { passcode?: string }) => {
    mockPasscodeValue = typeof data?.passcode === 'string' ? data.passcode : null;
    return { ok: true };
  },
  checkPasscode: async (data?: { passcode?: string }) => ({
    ok: mockPasscodeValue !== null && data?.passcode === mockPasscodeValue
  }),
  clearPasscode: async () => {
    mockPasscodeValue = null;
    return { ok: true };
  },

  // Persistent Notifications
  getShadeNotifications: async () => mockNotifications.filter((n) => !n.cleared_at),
  getNotificationHistory: async () => mockNotifications.filter((n) => n.cleared_at !== null),
  getUnreadCounts: async () => {
    const counts: Record<string, number> = {};
    for (const n of mockNotifications) {
      if (!n.cleared_at && !n.read_at) {
        counts[n.app] = (counts[n.app] || 0) + 1;
      }
    }
    return counts;
  },
  markNotificationRead: async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) n.read_at = now;
    });
    return true;
  },
  clearNotifications: async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) n.cleared_at = now;
    });
    return true;
  },
  clearAllNotifications: async (data?: { appId?: string }) => {
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (!data?.appId || n.app === data.appId) n.cleared_at = now;
    });
    return true;
  },
  restoreNotifications: async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) {
        n.cleared_at = null;
        n.read_at = null;
      }
    });
    return true;
  },

  // Navigation & Client Controls
  hideFrame: () => true,
  toggleFreelook: () => true,
  /**
   * Declining an incoming call — the one path that produces a `missed` row rather than
   * `outgoing`. `logCallEnd` in `server/services/Phone.ts` writes `missed` only to the
   * *target's* own log for an unanswered call, never to the caller's, so this is the
   * only mock action that should ever log that kind.
   */
  rejectCall: (payload?: { number?: string }): boolean => {
    const number = typeof payload?.number === 'string' ? payload.number : 'Unknown';
    logCall('missed', number, 0);
    activeCall = null;
    return true;
  },
  /**
   * DevTools' in-game "Simulate Incoming Call" path. Not what the browser button
   * itself calls — `DeveloperTools.svelte` fakes the toast locally there instead, same
   * as it always has — but the mock still needs an entry, and posting the real
   * `callStatus` message is what makes this genuinely exercisable from a console too.
   */
  simulateIncomingCall: (payload?: { number?: string }): { success: boolean } => {
    const number =
      typeof payload?.number === 'string' && payload.number ? payload.number : '5550100';
    window.postMessage(
      { action: 'callStatus', data: { status: 'incoming', number, name: 'Unknown' } },
      '*'
    );
    return { success: true };
  },
  setTyping: () => true,
  setBatteryLevel: () => true,
  // The browser has no ace list; the panel is unconditional there anyway.
  checkAdmin: () => ({ isAdmin: true }),

  /**
   * What a server behind this phone can do (`services/capabilities.ts`).
   *
   * The browser's own mocks answer for money — `getBalance`, `transferMoney` and Hodlr's
   * whole ledger are all here — so the honest answer for this transport is that it has it.
   * Answering `false` would take Bank and Hodlr off the dev launcher and out of every e2e
   * run while the mocks behind them kept working, which describes no real deployment.
   *
   * This is load-bearing rather than decorative: `refreshCapabilities` calls through the
   * transport in a browser too, instead of short-circuiting on `isBrowser()`, so a mock
   * that goes missing here shows up as two apps disappearing rather than as nothing at all.
   */
  checkCapabilities: () => ({ money: true }),

  /**
   * The AGPL §13 source address (`services/sourceUrl.ts`). Upstream here, because the mock
   * stands in for a server running an unmodified copy — which is what a browser session is.
   */
  getSourceUrl: () => ({ url: 'https://github.com/quissicutdeus/gPhone' }),

  /**
   * Broadcasting to people nearby (MICA-111 phase 2), which in a browser means nobody.
   *
   * Deliberately inert rather than fed back into `shell/state/nearbyMusic.ts` — echoing
   * your own broadcast to yourself would put a second player of your own track on your own
   * phone, a fraction out of sync with the first, which is a bug the real client is
   * careful to avoid (`client/services/Music.ts` drops the local player from the roster).
   * `window.pushNearbyMusic` in `shell/devHarness.ts` is how you hear somebody else in a
   * browser.
   */
  startMusicBroadcast: () => ({ ok: true }),
  updateMusicBroadcast: () => ({ ok: true }),
  stopMusicBroadcast: () => ({ ok: true })
};

/**
 * The generic service call, unwrapped so the mocks see the action they already know.
 *
 * `useService('journal').call('get')` arrives here as one `svc` action carrying
 * `{ service, action, data }`. Dispatching it to a `journal:get` key means an app using
 * the generic path is mockable exactly like every other one — and without this it would
 * be dead in `pnpm dev` and in Playwright, which is the failure §8 says a missing mock
 * always is.
 *
 * Falls back to the bare action name, so a service whose actions are also named routes
 * needs no second fixture.
 */
function resolveGeneric(data?: unknown): { key: string; payload: unknown } | null {
  if (!data || typeof data !== 'object') return null;
  const { service, action, data: inner } = data as Record<string, unknown>;
  if (typeof service !== 'string' || typeof action !== 'string') return null;

  const scoped = `${service}:${action}`;
  return { key: mockRegistry[scoped] ? scoped : action, payload: inner };
}

async function getMockData(eventName: string, data?: unknown): Promise<unknown> {
  if (eventName === GENERIC_SERVICE_ACTION) {
    const resolved = resolveGeneric(data);
    // Malformed shape (not even `{ service, action }`) is a caller bug, not a missing
    // mock — the real `ServiceEndpoint` answers a bad request rather than crashing the
    // page over it, so this stays a graceful `null` rather than joining the throw below.
    if (!resolved) {
      console.warn('[MockRegistry] Malformed generic service request', data);
      return null;
    }
    return getMockData(resolved.key, resolved.payload);
  }

  const handler = mockRegistry[eventName];
  if (handler) {
    return handler(data);
  }
  // A missing mock used to warn and answer `null`, which reads to the caller as "the
  // server sent nothing" rather than "nobody wired this up" — the exact failure this
  // registry exists to make visible instead of hidden. Throwing surfaces it the same
  // way a real unhandled route would.
  throw new Error(`[MockRegistry] No handler found for event: ${eventName}`);
}

export const MockRegistry = {
  has: (eventName: string) =>
    eventName === GENERIC_SERVICE_ACTION || Boolean(mockRegistry[eventName]),
  handle: (eventName: string, data?: unknown) => getMockData(eventName, data)
};
