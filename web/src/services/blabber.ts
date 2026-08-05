import { writable, derived } from 'svelte/store';
import type {
  Account,
  Blab,
  BlabEngagement,
  BlabberDm,
  BlabberDmThread,
  FollowStats
} from '@shared/types';
import { fetchNui } from '../nui/fetchNui';
import { createPagedStore } from './createPagedStore';
import { subscribeAppEvent } from '../shell/state/appEvents';
import { usePersisted } from '../sdk/hooks/usePersisted';

/**
 * Blabber's data: a paged public feed, plus the accounts the player can post from.
 *
 * Accounts are a separate concern from posts on purpose — the switcher has to work before
 * anything has been posted, and a player with no account yet needs to be told to claim one
 * rather than shown an empty feed.
 */

export const feed = createPagedStore<Blab>('getBlabs', { pageSize: 30 });

/**
 * The Following feed, a second paged store rather than a filter on the first.
 *
 * They are two server reads answering two different questions, each with its own cursor. Sharing
 * one store would mean one cursor walking two result sets, so switching tabs would resume the
 * other feed's position — and re-filtering a loaded page client-side is exactly what keyset
 * paging exists to avoid.
 */
export const followingFeed = createPagedStore<Blab>('getFollowingBlabs', { pageSize: 30 });

/** Every account this player holds in Blabber. Not anyone else's — the server scopes it. */
export const myAccounts = writable<Account[]>([]);
export const accountsLoaded = writable(false);

/**
 * Which account new posts are attributed to. Null until accounts have loaded.
 *
 * Persisted, because it is a choice rather than a cache: a player with a main and an alt was
 * silently returned to the first account every time the phone reloaded, so the next post went
 * out under the wrong handle with nothing on screen having changed.
 *
 * `useStorage` is `localStorage`, so this is per-PC and shared between characters — which is
 * survivable here precisely because `loadMyAccounts` re-validates the stored id against the
 * accounts the server actually returned and falls back to the first one. A stale id from
 * another character corrects itself on the next load rather than posting as somebody else.
 */
export const activeAccountId = usePersisted<number | null>('blabber', 'activeAccountId', null, {
  sanitize: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
});

export const activeAccount = derived(
  [myAccounts, activeAccountId],
  ([accounts, id]) => accounts.find((account) => account.id === id) ?? accounts[0] ?? null
);

/**
 * How long after posting an edit is still accepted, in seconds.
 *
 * Reported by the server so the UI can hide the Edit button once it has passed. A courtesy —
 * the predicate in the `UPDATE` is the boundary — but a button that appears and then fails is
 * worse than one that was never there.
 */
export const editWindow = writable(900);

/**
 * How many accounts this player may hold in Blabber, as reported by the server.
 *
 * A convar (`gphone_max_accounts_per_app`) the phone cannot read, so it arrives with the account
 * list. Not hardcoded here: a copy of a server default drifts the first time an owner raises it,
 * and the symptom is a Claim button missing for a player who is entitled to another handle.
 */
export const accountLimit = writable(3);

/** Room for another identity. What decides whether the account sheet offers to claim one. */
export const canClaimAnother = derived(
  [myAccounts, accountLimit],
  ([accounts, limit]) => accounts.length < limit
);

export const loadMyAccounts = async (): Promise<void> => {
  try {
    const reply = await fetchNui<{ rows: Account[]; limit: number }>(
      'getMyAccounts',
      { app: 'blabber' },
      { defaultValue: { rows: [], limit: 3 } }
    );
    const rows = reply.rows ?? [];
    myAccounts.set(rows);
    if (typeof reply.limit === 'number') accountLimit.set(reply.limit);
    activeAccountId.update((current) =>
      current !== null && rows.some((a) => a.id === current) ? current : (rows[0]?.id ?? null)
    );
  } finally {
    accountsLoaded.set(true);
  }
};

/**
 * Edit the display half of an identity.
 *
 * `handle` is absent on purpose and cannot be added: it is `clientWritable: false` server-side,
 * because renaming it would silently break every mention already posted and there is nothing to
 * un-break them with.
 */
export const updateAccount = async (
  id: number,
  patch: Pick<Partial<Account>, 'display_name' | 'avatar' | 'bio'>
): Promise<void> => {
  await fetchNui('updateAccount', { id, ...patch });
  myAccounts.update((current) =>
    current.map((account) => (account.id === id ? { ...account, ...patch } : account))
  );
};

/** Claim a handle. Throws with a readable message when it is taken or malformed. */
export const claimAccount = async (handle: string, displayName?: string): Promise<Account> => {
  const created = await fetchNui<Account>('createAccount', {
    app: 'blabber',
    handle,
    display_name: displayName
  });
  myAccounts.update((current) => [...current, created]);
  activeAccountId.set(created.id);
  return created;
};

/** Post. Prepends optimistically only after the server has confirmed the row. */
export const postBlab = async (body: string, replyTo?: number | null): Promise<Blab> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle before posting.');

  const created = await fetchNui<Blab & { editWindow?: number }>('createBlab', {
    account_id: accountId,
    body,
    reply_to: replyTo ?? undefined
  });
  if (typeof created.editWindow === 'number') editWindow.set(created.editWindow);
  feed.prepend(created);
  return created;
};

export const editBlab = async (id: number, body: string): Promise<void> => {
  await fetchNui('updateBlab', { id, body });
  feed.replace({ ...findInFeed(id), id, body } as Blab);
};

export const deleteBlab = async (id: number): Promise<void> => {
  await fetchNui('deleteBlab', { id });
  feed.remove(id);
};

/** Reading a store's value without subscribing, for the two callers that need it imperatively. */
let activeIdSnapshot: number | null = null;
activeAccount.subscribe((account) => (activeIdSnapshot = account?.id ?? null));
const getActiveAccountId = () => activeIdSnapshot;

let feedSnapshot: Blab[] = [];
feed.subscribe((rows) => (feedSnapshot = rows));
const findInFeed = (id: number): Partial<Blab> => feedSnapshot.find((row) => row.id === id) ?? {};

/**
 * Engagement for the Blabs currently on screen.
 *
 * Fetched in one batch for a page of ids rather than three counts per row — thirty posts asking
 * individually is ninety round trips through NUI. Kept in its own map rather than merged onto the
 * rows so a like can update without the feed store replacing a row and losing its identity in
 * the keyed `{#each}`.
 *
 * Not denormalised onto the Blab either: a `like_count` column is a second copy of a fact the
 * likes table already holds, and it drifts the first time something removes a like without
 * decrementing.
 */
export const engagement = writable<Record<number, BlabEngagement>>({});

const EMPTY: BlabEngagement = {
  replies: 0,
  mouths: 0,
  likes: 0,
  likedByMe: false,
  mouthedByMe: false
};

export const loadEngagement = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return;
  const reply = await fetchNui<Record<number, BlabEngagement>>(
    'getBlabEngagement',
    { ids },
    { defaultValue: {} }
  );
  engagement.update((current) => ({ ...current, ...reply }));
};

/** Optimistic, then reconciled: a heart must fill on tap, not after a round trip. */
export const toggleLike = async (blabId: number): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle first.');

  let liked = false;
  engagement.update((current) => {
    const existing = current[blabId] ?? EMPTY;
    liked = existing.likedByMe;
    return {
      ...current,
      [blabId]: {
        ...existing,
        likedByMe: !liked,
        likes: Math.max(0, existing.likes + (liked ? -1 : 1))
      }
    };
  });

  try {
    // Two literal calls rather than one with a ternary action name. A computed action is
    // invisible to `routes.test.ts`, which cross-references every layer by scanning for
    // literals — and a route it cannot see is reported as dead weight.
    if (liked) {
      await fetchNui('unlikeBlab', { blab_id: blabId, account_id: accountId });
    } else {
      await fetchNui('likeBlab', { blab_id: blabId, account_id: accountId });
    }
  } catch (error) {
    // Put it back. An optimistic update that survives a failed write is a lie the UI tells.
    await loadEngagement([blabId]);
    throw error;
  }
};

/**
 * The follow graph.
 *
 * Keyed by the account being looked at, like `engagement` is keyed by Blab — a profile is opened,
 * read, and left, so caching by id means going back to one shows what it showed before rather
 * than a blank while it refetches.
 */
export const followStats = writable<Record<number, FollowStats>>({});

const NO_FOLLOWS: FollowStats = { followers: 0, following: 0, followedByMe: false };

export const loadFollowStats = async (accountId: number): Promise<void> => {
  const reply = await fetchNui<FollowStats>(
    'getFollowStats',
    { app: 'blabber', account_id: accountId, viewer_account_id: getActiveAccountId() ?? undefined },
    { defaultValue: NO_FOLLOWS }
  );
  followStats.update((current) => ({ ...current, [accountId]: reply }));
};

/**
 * Follow or unfollow, optimistically.
 *
 * Same shape as `toggleLike`, and for the same reason: a Follow button must change on tap rather
 * than after a round trip. A failure puts it back, because an optimistic update that survives a
 * refused write is a lie the UI tells.
 *
 * The count moves with the button. Following somebody and watching their follower count sit still
 * reads as the tap not having worked.
 */
export const toggleFollow = async (accountId: number): Promise<void> => {
  const follower = getActiveAccountId();
  if (follower === null) throw new Error('Claim a handle first.');
  if (follower === accountId) throw new Error('You cannot follow yourself.');

  let wasFollowing = false;
  followStats.update((current) => {
    const existing = current[accountId] ?? NO_FOLLOWS;
    wasFollowing = existing.followedByMe;
    return {
      ...current,
      [accountId]: {
        ...existing,
        followedByMe: !wasFollowing,
        followers: Math.max(0, existing.followers + (wasFollowing ? -1 : 1))
      }
    };
  });

  try {
    // Two literal calls rather than one with a computed action name, which `routes.test.ts`
    // cannot see — and a route it cannot see is reported as dead weight.
    if (wasFollowing) {
      await fetchNui('unfollowAccount', {
        app: 'blabber',
        follower_account_id: follower,
        followee_account_id: accountId
      });
    } else {
      await fetchNui('followAccount', {
        app: 'blabber',
        follower_account_id: follower,
        followee_account_id: accountId
      });
    }
  } catch (error) {
    await loadFollowStats(accountId);
    throw error;
  }
};

/**
 * The Following feed for whichever account is active.
 *
 * The account id is a filter rather than something the server infers, because a player may hold
 * several and only one of them is posting — the server still verifies it belongs to the caller.
 */
export const loadFollowing = async (): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) return;
  await followingFeed.load({ account_id: accountId });
};

/** Mouth a Blab — a repeat, or a quote when a body is supplied. */
export const mouthBlab = async (blabId: number, body?: string): Promise<Blab> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle first.');

  const created = await fetchNui<Blab>('createBlab', {
    account_id: accountId,
    mouth_of: blabId,
    body: body?.trim() || undefined
  });
  // The server hydrates `mouthed` into its echo. This used to graft it on from the local feed,
  // which meant mouthing from a profile or a thread — anywhere the target was not already in the
  // window — prepended a row whose quote card was empty.
  feed.prepend(created);
  await loadEngagement([blabId]);
  return created;
};

/** One Blab and its direct replies. Replies nest, so a reply's own thread is the same call. */
export const loadThread = async (
  blabId: number
): Promise<{ rows: Blab[]; nextCursor: number | null }> =>
  await fetchNui<{ rows: Blab[]; nextCursor: number | null }>(
    'getBlabs',
    { reply_to: blabId },
    { defaultValue: { rows: [], nextCursor: null } }
  );

/**
 * Unread mentions, for the launcher badge.
 *
 * Subscribed at **module scope**, which is the load-bearing part. The registry imports this file
 * before anything mounts and the CEF page never unloads, so this subscription outlives every
 * open/close of the phone — a badge fed from inside a component would only count mentions that
 * arrived while the app happened to be on screen, which is precisely when a badge stops
 * mattering.
 */
export const unreadMentions = writable(0);

subscribeAppEvent('blabber', 'mention', () => {
  unreadMentions.update((n) => n + 1);
});

/** Called when the feed is read, since the mentions are in it. */
export const clearUnreadMentions = (): void => unreadMentions.set(0);

/**
 * Direct messages. Strictly 1:1, so a thread is identified by the peer account rather than by a
 * conversation row — there is no thread entity to create, and none to accidentally add a third
 * person to.
 */
export const dmThreads = writable<BlabberDmThread[]>([]);
export const dmMessages = writable<BlabberDm[]>([]);

/** Unread DMs across every account, for the badge. */
export const unreadDms = derived(dmThreads, (threads) =>
  threads.reduce((total, thread) => total + thread.unread, 0)
);

export const loadDmThreads = async (): Promise<void> => {
  dmThreads.set(await fetchNui<BlabberDmThread[]>('getDmThreads', {}, { defaultValue: [] }));
};

export const loadDmMessages = async (peerAccountId: number): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) return;
  const reply = await fetchNui<{ rows: BlabberDm[] }>(
    'getDmMessages',
    { account_id: accountId, peer_account_id: peerAccountId },
    { defaultValue: { rows: [] } }
  );
  dmMessages.set(reply.rows ?? []);

  // Opening the thread is what marks it read, so the badge falls for the same reason the player
  // would expect it to.
  await fetchNui('markDmRead', { account_id: accountId, peer_account_id: peerAccountId });
  await loadDmThreads();
};

export const sendDm = async (peerAccountId: number, body: string): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle first.');

  const created = await fetchNui<BlabberDm>('sendDm', {
    account_id: accountId,
    peer_account_id: peerAccountId,
    body
  });
  dmMessages.update((current) => [created, ...current]);
  await loadDmThreads();
};

/**
 * An incoming DM, subscribed at module scope.
 *
 * Same reasoning as the mention badge: the registry imports this file before anything mounts and
 * the CEF page never unloads, so this survives the phone closing. A subscription inside the app
 * would only see DMs that arrived while Blabber happened to be on screen.
 */
subscribeAppEvent('blabber', 'dm', () => {
  void loadDmThreads();
});
