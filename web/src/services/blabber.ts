import { writable, derived } from 'svelte/store';
import type { Account, Blab, BlabEngagement } from '@shared/types';
import { fetchNui } from '../nui/fetchNui';
import { createPagedStore } from './createPagedStore';

/**
 * Blabber's data: a paged public feed, plus the accounts the player can post from.
 *
 * Accounts are a separate concern from posts on purpose — the switcher has to work before
 * anything has been posted, and a player with no account yet needs to be told to claim one
 * rather than shown an empty feed.
 */

export const feed = createPagedStore<Blab>('getBlabs', { pageSize: 30 });

/** Every account this player holds in Blabber. Not anyone else's — the server scopes it. */
export const myAccounts = writable<Account[]>([]);
export const accountsLoaded = writable(false);

/** Which account new posts are attributed to. Null until accounts have loaded. */
export const activeAccountId = writable<number | null>(null);

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

export const loadMyAccounts = async (): Promise<void> => {
  try {
    const rows = await fetchNui<Account[]>(
      'getMyAccounts',
      { app: 'blabber' },
      { defaultValue: [] }
    );
    myAccounts.set(rows);
    activeAccountId.update((current) =>
      current !== null && rows.some((a) => a.id === current) ? current : (rows[0]?.id ?? null)
    );
  } finally {
    accountsLoaded.set(true);
  }
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

/** Mouth a Blab — a repeat, or a quote when a body is supplied. */
export const mouthBlab = async (blabId: number, body?: string): Promise<Blab> => {
  const accountId = getActiveAccountId();
  if (accountId === null) throw new Error('Claim a handle first.');

  const created = await fetchNui<Blab>('createBlab', {
    account_id: accountId,
    mouth_of: blabId,
    body: body?.trim() || undefined
  });
  feed.prepend({ ...created, mouthed: findInFeed(blabId) as Blab });
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
