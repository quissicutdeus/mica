import { writable, derived } from 'svelte/store';
import type {
  Account,
  Blab,
  BlabEngagement,
  BlabberDm,
  BlabberDmThread,
  FollowStats
} from '@shared/types';
import {
  createPagedStore,
  useAppEvents,
  useNuiBridge,
  usePersisted,
  useService
} from '@gphone/sdk';

/**
 * Blabber's own data layer, inside the app.
 *
 * It used to be `web/src/services/blabber.ts` plus `sdk/hooks/useBlabber.ts` — a store in
 * core and a hook in the SDK, for an app declaring `core: false`. Neither is something an
 * app installed from the Store can add, which made the label aspirational;
 * `sdk/coreBoundary.test.ts` counted the references saying so.
 *
 * Blabber's own service goes through `useService`, so `shared/routes.ts` needs no rows for
 * it. **The `accounts` calls stay named**, and that is not an oversight: `gphone_accounts`
 * is the shared identity service every social app posts under, so it is core, and its
 * routes are core's to declare.
 */
// Resolved per call for the same reason as `fetchNui` below: a handle captured at module
// scope closes over the transport as it was at import time.
const blabberService = () => useService('blabber');
const dmService = () => useService('blabber_dms');
/**
 * Resolved per call, not destructured once.
 *
 * Holding the function from module scope captures whatever `useNuiBridge` returned at
 * import time — which is the real transport, before any test has installed a spy on it.
 * The store then talks to the live mock registry while the test asserts against its own
 * stubs, and the failure reads as wrong fixture data rather than as a stale binding.
 */
const fetchNui = <T = unknown>(
  action: string,
  data?: unknown,
  options?: { defaultValue: T }
): Promise<T> => useNuiBridge().fetchNui<T>(action, data, options);
const { on: onBlabberKind } = useAppEvents('blabber');

/**
 * Blabber's data: a paged public feed, plus the accounts the player can post from.
 *
 * Accounts are a separate concern from posts on purpose — the switcher has to work before
 * anything has been posted, and a player with no account yet needs to be told to claim one
 * rather than shown an empty feed.
 */

export const feed = createPagedStore<Blab>('get', { pageSize: 30, service: 'blabber' });

/**
 * The Following feed, a second paged store rather than a filter on the first.
 *
 * They are two server reads answering two different questions, each with its own cursor. Sharing
 * one store would mean one cursor walking two result sets, so switching tabs would resume the
 * other feed's position — and re-filtering a loaded page client-side is exactly what keyset
 * paging exists to avoid.
 */
export const followingFeed = createPagedStore<Blab>('following', {
  pageSize: 30,
  service: 'blabber'
});

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

  const created = await blabberService().call<Blab & { editWindow?: number }>('create', {
    account_id: accountId,
    body,
    reply_to: replyTo ?? undefined
  });
  if (typeof created.editWindow === 'number') editWindow.set(created.editWindow);
  feed.prepend(created);
  return created;
};

export const editBlab = async (id: number, body: string): Promise<void> => {
  await blabberService().call('update', { id, body });
  feed.replace({ ...findInFeed(id), id, body } as Blab);
};

export const deleteBlab = async (id: number): Promise<void> => {
  await blabberService().call('delete', { id });
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
  const reply = await blabberService().call<Record<number, BlabEngagement>>(
    'engagement',
    { ids },
    {}
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
      await blabberService().call('unlike', { blab_id: blabId, account_id: accountId });
    } else {
      await blabberService().call('like', { blab_id: blabId, account_id: accountId });
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
 * The two lists behind the counts, each its own paged store.
 *
 * Two stores rather than one keyed by direction, for the reason `followingFeed` is separate from
 * `feed`: each holds a cursor, and one cursor cannot walk two result sets. They are *not* keyed by
 * account, though — unlike `followStats`, which caches per profile because a profile is opened,
 * read and left. A list is opened deliberately, is expected to be current, and only one is ever on
 * screen, so `load` replacing the window is the right behavior and a per-account cache would just
 * be a way to show a stale list.
 */
export const followers = createPagedStore<Account>('getFollowers', { pageSize: 30 });
export const following = createPagedStore<Account>('getFollowing', { pageSize: 30 });

/**
 * Whose followers, or whose following. Public, so no viewer identity is sent: these read the same
 * whoever is looking, and the Follow button lives on the profile a row opens rather than in the
 * list — thirty rows each asking for their own follow state is the round-trip storm the batched
 * `engagement` read exists to avoid.
 */
export const loadFollowers = async (accountId: number): Promise<void> => {
  await followers.load({ app: 'blabber', account_id: accountId });
};

export const loadFollowingList = async (accountId: number): Promise<void> => {
  await following.load({ app: 'blabber', account_id: accountId });
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

  const created = await blabberService().call<Blab>('create', {
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
  await blabberService().call<{ rows: Blab[]; nextCursor: number | null }>(
    'get',
    { reply_to: blabId },
    { rows: [], nextCursor: null }
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

onBlabberKind('mention', () => {
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
  dmThreads.set(await dmService().call<BlabberDmThread[]>('threads', {}, []));
};

export const loadDmMessages = async (peerAccountId: number): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) return;
  const reply = await dmService().call<{ rows: BlabberDm[] }>(
    'get',
    { account_id: accountId, peer_account_id: peerAccountId },
    { rows: [] }
  );
  dmMessages.set(reply.rows ?? []);

  // Opening the thread is what marks it read, so the badge falls for the same reason the player
  // would expect it to.
  await dmService().call('read', { account_id: accountId, peer_account_id: peerAccountId });
  await loadDmThreads();
};

export const sendDm = async (peerAccountId: number, body: string): Promise<void> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle first.');

  const created = await dmService().call<BlabberDm>('send', {
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
onBlabberKind('dm', () => {
  void loadDmThreads();
});

/**
 * What the app's components call. Was `sdk/hooks/useBlabber.ts`; an add-on cannot put a
 * hook in the SDK, which is the whole reason this moved.
 */
export function useBlabber() {
  return {
    feed,
    followingFeed,
    /**
     * The two lists behind a profile's counts. Read-only from an app's side: they are filled by
     * the loaders below, which name whose list is wanted.
     */
    followers,
    following,
    loadFollowers: (accountId: number) => loadFollowers(accountId),
    loadFollowingList: (accountId: number) => loadFollowingList(accountId),
    followStats,
    loadFollowing: () => loadFollowing(),
    loadFollowStats: (accountId: number) => loadFollowStats(accountId),
    toggleFollow: (accountId: number) => toggleFollow(accountId),
    myAccounts,
    accountsLoaded,
    accountLimit,
    canClaimAnother,
    activeAccount,
    activeAccountId,
    editWindow,
    engagement,
    unreadMentions,
    clearUnreadMentions: () => clearUnreadMentions(),
    dmThreads,
    dmMessages,
    unreadDms,
    loadDmThreads: () => loadDmThreads(),
    loadDmMessages: (peerAccountId: number) => loadDmMessages(peerAccountId),
    sendDm: (peerAccountId: number, body: string) => sendDm(peerAccountId, body),
    loadEngagement: (ids: number[]) => loadEngagement(ids),
    loadThread: (blabId: number) => loadThread(blabId),
    toggleLike: (blabId: number) => toggleLike(blabId),
    mouthBlab: (blabId: number, body?: string) => mouthBlab(blabId, body),
    loadMyAccounts: () => loadMyAccounts(),
    claimAccount: (handle: string, displayName?: string) => claimAccount(handle, displayName),
    updateAccount: (id: number, patch: Parameters<typeof updateAccount>[1]) =>
      updateAccount(id, patch),
    postBlab: (body: string, replyTo?: number | null) => postBlab(body, replyTo),
    editBlab: (id: number, body: string) => editBlab(id, body),
    deleteBlab: (id: number) => deleteBlab(id)
  };
}
