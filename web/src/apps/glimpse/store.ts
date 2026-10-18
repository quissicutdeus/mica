// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, derived } from 'svelte/store';
import type { ActionInput, ActionOutput } from '@mica/shared/contract';
import type { glimpseCommentsContract } from '@mica/shared/contracts/glimpse_comments';
import type {
  Account,
  FollowStats,
  GlimpseCreated,
  GlimpseEngagement,
  GlimpsePost
} from '@mica/shared/types';
import {
  createPagedStore,
  createReactionStore,
  useAccounts,
  usePersisted,
  useService
} from '@mica/sdk';

/**
 * Glimpse's data layer (MICA-253), inside the app, for Blabber's reason: an add-on cannot put
 * a store in core or a hook in the SDK, so everything it holds lives in its own module.
 *
 * The posts go through `useService('glimpse')`, untyped, because the posts contract lives
 * beside its `defineService` in `server/services/Glimpse.ts` — an add-on's id may not be named
 * in `shared/`. The comments contract is `glimpse_comments`, which is not the add-on's id, so it
 * sits in `shared/contracts/` and its input and output types are read from there below.
 *
 * Accounts, follows and likes are the shared `accounts` service, reached through its facet:
 * a sandboxed add-on has no other door to a service that is not its own.
 */

/** The `app` every `mica_accounts` read and write names. Handles are per app, by decision. */
const APP = 'glimpse';

/** The one reaction a post can carry. The server refuses any other on `mica_glimpse`. */
export const LIKE = '❤️';

/** What `mica_account_reactions.target_table` names for a post. */
const POST_TABLE = 'mica_glimpse';

// Resolved per call, as in Blabber: a handle captured at module scope closes over the
// transport as it was at import time.
const glimpseService = () => useService('glimpse');
const commentService = () => useService('glimpse_comments');
const accounts = () => useAccounts();

type Comments = typeof glimpseCommentsContract;
type CommentPage = ActionOutput<Comments, 'list'>;

/** The public feed: every active post, newest first, less what the viewer has blocked. */
export const feed = createPagedStore<GlimpsePost>('feed', { pageSize: 30, service: 'glimpse' });

/**
 * Posts by accounts the active one follows. A second paged store rather than a filter on the
 * first: two server reads with two cursors, and one cursor cannot walk both.
 */
export const followingFeed = createPagedStore<GlimpsePost>('following', {
  pageSize: 30,
  service: 'glimpse'
});

/** Every account this player holds in Glimpse. The server scopes it to the caller. */
export const myAccounts = writable<Account[]>([]);
export const accountsLoaded = writable(false);

/**
 * Which account posts, likes and comments act as. Persisted because it is a choice, and
 * re-validated by `loadMyAccounts` against what the server returned — a stale id from another
 * character falls back to the first account rather than acting as somebody else.
 */
export const activeAccountId = usePersisted<number | null>('glimpse', 'activeAccountId', null, {
  sanitize: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
});

export const activeAccount = derived(
  [myAccounts, activeAccountId],
  ([list, id]) => list.find((account) => account.id === id) ?? list[0] ?? null
);

/** Seconds a caption stays editable, as `create` reports it (`mica_glimpse_edit_window`). */
export const editWindow = writable(900);

/** The per-app cap on handles, as the server reports it with the account list. */
export const accountLimit = writable(3);

export const canClaimAnother = derived(
  [myAccounts, accountLimit],
  ([list, limit]) => list.length < limit
);

let activeIdSnapshot: number | null = null;
activeAccount.subscribe((account) => (activeIdSnapshot = account?.id ?? null));
export const getActiveAccountId = (): number | null => activeIdSnapshot;

const requireAccount = (): number => {
  const id = getActiveAccountId();
  if (id === null) throw new Error('Claim a handle first.');
  return id;
};

/**
 * Read this player's Glimpse accounts. Never rejects: it runs from `preload` and
 * `onAppForeground`. A failure keeps the last list, so one failed read never shows a player who
 * holds a handle the screen for claiming their first.
 */
export const loadMyAccounts = async (): Promise<void> => {
  let reply: Awaited<ReturnType<ReturnType<typeof accounts>['getMyAccounts']>>;
  try {
    reply = await accounts().getMyAccounts(APP);
  } catch (error) {
    console.warn('micaOS Glimpse: could not load your accounts', error);
    return;
  }
  const rows = reply.rows;
  myAccounts.set(rows);
  if (typeof reply.limit === 'number') accountLimit.set(reply.limit);
  activeAccountId.update((current) =>
    current !== null && rows.some((a) => a.id === current) ? current : (rows[0]?.id ?? null)
  );
  accountsLoaded.set(true);
};

/** Claim a handle in Glimpse. Throws with a readable message when it is taken or malformed. */
export const claimAccount = async (handle: string): Promise<Account> => {
  const created = await accounts().createAccount({ app: APP, handle });
  myAccounts.update((current) => [...current, created]);
  activeAccountId.set(created.id);
  return created;
};

/** Edit the display half of an identity. The handle is never client-writable. */
export const updateAccount = async (
  id: number,
  patch: Pick<Partial<Account>, 'display_name' | 'bio'>
): Promise<void> => {
  await accounts().updateAccount({ id, ...patch });
  myAccounts.update((current) =>
    current.map((account) => (account.id === id ? { ...account, ...patch } : account))
  );
};

/** Reload the public feed as the active account, so the server drops what it has blocked. */
export const loadFeed = async (): Promise<void> => {
  await feed.load({ account_id: getActiveAccountId() ?? undefined });
};

export const loadFollowing = async (): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) return;
  await followingFeed.load({ account_id: accountId });
};

/** Post photos with an optional caption. Prepends only once the server has the row. */
export const createPost = async (
  caption: string,
  attachments: { photo_id: number }[]
): Promise<GlimpsePost> => {
  const accountId = requireAccount();
  const created = await glimpseService().call<GlimpseCreated>('create', {
    account_id: accountId,
    caption: caption.trim() || undefined,
    attachments
  });
  if (typeof created.editWindow === 'number') editWindow.set(created.editWindow);
  feed.prepend(created);
  return created;
};

/** Edit a caption, inside the window. The generic ownership-scoped update. */
export const editCaption = async (post: GlimpsePost, caption: string): Promise<GlimpsePost> => {
  const next = caption.trim() || null;
  await glimpseService().call('update', { id: post.id, caption: next });
  const updated = { ...post, caption: next, updated_at: new Date().toISOString() };
  feed.replace(updated);
  followingFeed.replace(updated);
  return updated;
};

/** Delete one of my posts — a soft delete through the generic ownership-scoped path. */
export const deletePost = async (id: number): Promise<void> => {
  await glimpseService().call('delete', { id });
  feed.remove(id);
  followingFeed.remove(id);
};

/** One post, or null when it is gone, moderated or never existed. Rejects on failure. */
export const viewPost = (id: number): Promise<GlimpsePost | null> =>
  glimpseService().call<GlimpsePost | null>('view', { id });

/**
 * Comment counts for what is on screen, one batched read per window rather than one per post.
 * Kept in its own map so a count can move without replacing a row in the keyed `{#each}`.
 */
export const engagement = writable<Record<number, GlimpseEngagement>>({});

export const loadEngagement = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return;
  const reply = await glimpseService().call<Record<number, GlimpseEngagement>>(
    'engagement',
    { ids },
    {}
  );
  engagement.update((current) => ({ ...current, ...reply }));
};

const bumpComments = (postId: number, by: number) =>
  engagement.update((current) => ({
    ...current,
    [postId]: { comments: Math.max(0, (current[postId]?.comments ?? 0) + by) }
  }));

/**
 * Likes: ❤️ on the shared reactions primitive, through the `accounts` facet. The payload is
 * rebuilt per call so a switch of account between two taps likes as the account now active.
 */
const likePayload = (targetId: number, emoji: string) => ({
  app: APP,
  account_id: requireAccount(),
  target_table: POST_TABLE,
  target_id: targetId,
  emoji
});

export const likes = createReactionStore({
  load: (ids) =>
    accounts().getReactionsFor({ app: APP, target_table: POST_TABLE, target_ids: ids }),
  // Two literal calls, as everywhere else: a computed action name is invisible to the scans.
  react: (targetId, emoji) => accounts().reactToTarget(likePayload(targetId, emoji)),
  unreact: (targetId, emoji) => accounts().unreactToTarget(likePayload(targetId, emoji))
});

/** Never rejects: the feed fires it without waiting, and a failed read keeps what it had. */
export const loadLikes = (ids: number[]): Promise<void> =>
  likes.load(ids).catch((error) => {
    console.warn('micaOS Glimpse: could not load likes', error);
  });

/**
 * Like or unlike. The handle check comes first because the store paints before it calls the
 * transport — a player with no handle would otherwise see the heart fill and snap back.
 */
export const toggleLike = async (postId: number): Promise<void> => {
  requireAccount();
  await likes.toggle(postId, LIKE);
};

/** One page of a post's comments, newest first. Rejects on failure. */
export const loadComments = async (
  postId: number,
  cursor: number | null = null
): Promise<CommentPage> => {
  const input: ActionInput<Comments, 'list'> = { post_id: postId, cursor: cursor ?? undefined };
  return await commentService().call<CommentPage>('list', input);
};

/** Comment as the active account. */
export const addComment = async (
  postId: number,
  body: string
): Promise<ActionOutput<Comments, 'create'>> => {
  const input: ActionInput<Comments, 'create'> = {
    account_id: requireAccount(),
    post_id: postId,
    body: body.trim()
  };
  const created = await commentService().call<ActionOutput<Comments, 'create'>>('create', input);
  bumpComments(postId, 1);
  return created;
};

/**
 * Remove a comment, as its author or as the owner of the post. `actingAs` is whichever of my
 * accounts has that right — the server checks it is mine and that it is one of the two.
 */
export const removeComment = async (
  postId: number,
  commentId: number,
  actingAs: number
): Promise<void> => {
  const input: ActionInput<Comments, 'remove'> = { account_id: actingAs, id: commentId };
  const removed = await commentService().call<ActionOutput<Comments, 'remove'>>('remove', input);
  if (removed === false) throw new Error('That comment is already gone.');
  bumpComments(postId, -1);
};

/**
 * Who a DM thread is with (MICA-393): enough to title it. An inbox row carries a handle and a
 * display name and no avatar, so the avatar is optional rather than invented.
 */
export type GlimpsePeer = Pick<Account, 'id' | 'handle' | 'display_name'> & {
  avatar?: string | null;
};

/** The account behind a handle, in Glimpse. Null when nobody holds it. Rejects on failure. */
export const findAccount = async (handle: string): Promise<Account | null> => {
  const reply = await accounts().getAccounts({ app: APP, handle, limit: 1 });
  return reply.rows[0] ?? null;
};

/** One profile's grid, as the active account sees it. Rejects on failure. */
export const loadProfilePage = (
  accountId: number,
  cursor: number | null = null
): Promise<{ account: Account | null; rows: GlimpsePost[]; nextCursor: number | null }> =>
  glimpseService().call('profile', {
    account_id: accountId,
    viewer_account_id: getActiveAccountId() ?? undefined,
    cursor: cursor ?? undefined
  });

/** The follow graph, keyed by the account being looked at. */
export const followStats = writable<Record<number, FollowStats>>({});

const NO_FOLLOWS: FollowStats = {
  followers: 0,
  following: 0,
  followedByMe: false,
  blockedByMe: false
};

export const loadFollowStats = async (accountId: number): Promise<void> => {
  const reply = await accounts().getFollowStats({
    app: APP,
    account_id: accountId,
    viewer_account_id: getActiveAccountId() ?? undefined
  });
  followStats.update((current) => ({ ...current, [accountId]: reply }));
};

/** Follow or unfollow as the active account, optimistically, put back on a refusal. */
export const toggleFollow = async (accountId: number): Promise<void> => {
  const follower = requireAccount();
  if (follower === accountId) throw new Error('You cannot follow yourself.');

  let wasFollowing = false;
  let before: FollowStats | undefined;
  followStats.update((current) => {
    before = current[accountId];
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
    if (wasFollowing) {
      await accounts().unfollowAccount({
        app: APP,
        follower_account_id: follower,
        followee_account_id: accountId
      });
    } else {
      await accounts().followAccount({
        app: APP,
        follower_account_id: follower,
        followee_account_id: accountId
      });
    }
  } catch (error) {
    try {
      await loadFollowStats(accountId);
    } catch {
      followStats.update((current) => {
        const next = { ...current };
        if (before) next[accountId] = before;
        else delete next[accountId];
        return next;
      });
    }
    throw error;
  }
};
