import { writable, derived } from 'svelte/store';
import type { Account, Blab } from '@shared/types';
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
