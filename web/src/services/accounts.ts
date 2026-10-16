// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchNui } from '../nui/fetchNui';
import { call } from '../nui/call';
import { accountsContract } from '@mica/shared/contracts/accounts';
import type { Account, FollowStats } from '@mica/shared/types';
import type { AccountSearchQuery, FollowListQuery, FollowPage, ReactionTarget } from '@mica/sdk';

/**
 * The shared social-identity service, as functions.
 *
 * `mica_accounts` is core — every social app posts under a handle from it — so its
 * routes are named rows in `shared/routes.ts`, and until now the only way an add-on
 * could reach them was the raw transport. Blabber did exactly that through
 * `useNuiBridge`, which is the hatch MICA-16 closes. No store here on purpose: which
 * accounts are "mine" is per app, and the app holds that.
 */

/**
 * A reply that is not the shape asked for, refused like a failed request.
 *
 * `call` hands a `null` reply back as `null`, and a read that turned that into an empty
 * answer would be the lie these functions stopped telling.
 */
const malformed = (action: string): Error =>
  new Error(`accounts:${action} answered with an unexpected shape`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * **Every read here throws on failure** — no `defaultValue`, the rule the paged reads below
 * already followed. These four used to resolve an empty page, zero counts or an empty map
 * when the request never reached the server, which is exactly what a real "nothing" looks
 * like: a failed `getMyAccounts` showed a player who already holds a handle the screen for
 * claiming their first one, a failed `getFollowStats` overwrote real counts with zeros, and
 * a failed `getReactionsFor` wiped every chip it was asked about. The caller holds the last
 * answer it had and decides what a failure does to it.
 */
export const getMyAccounts = async (app: string) => {
  const reply = await call(accountsContract, 'mine', { app });
  if (!isRecord(reply) || !Array.isArray(reply.rows)) throw malformed('mine');
  return reply;
};

export const getAccounts = async (query: { app: string; handle?: string; limit?: number }) => {
  const reply = await fetchNui<{ rows: Account[] }>('getAccounts', query);
  if (!isRecord(reply) || !Array.isArray(reply.rows)) throw malformed('get');
  return reply;
};

export const createAccount = (input: { app: string; handle: string; display_name?: string }) =>
  call(accountsContract, 'create', input);

export const updateAccount = (input: { id: number } & Partial<Account>) =>
  fetchNui('updateAccount', input, undefined);

export const getFollowStats = async (input: {
  app: string;
  account_id: number;
  viewer_account_id?: number;
}): Promise<FollowStats> => {
  const reply: unknown = await call(accountsContract, 'follows', input);
  if (
    !isRecord(reply) ||
    typeof reply.followers !== 'number' ||
    typeof reply.following !== 'number'
  ) {
    throw malformed('follows');
  }
  return reply as unknown as FollowStats;
};

/**
 * The two lists behind those counts, paged.
 *
 * Here rather than as a bare paged store named for the action inside Blabber, because
 * Blabber is an add-on now: `sdk/host/iframe/fetchNui.ts` refuses a named NUI action from
 * inside the sandbox, and the generic service route is pinned to the app's own namespace
 * (`IframeHostServer`'s `serviceAllowed`) — so the only door an add-on has to a *shared*
 * service is its enumerated facet, which is this module. Public, like the counts: no
 * viewer identity is sent, because these read the same whoever is looking.
 */
// Two literal calls rather than one helper taking the action name, for the reason
// `toggleFollow` gives: `server/__tests__/routes.test.ts` scans for the contract's action
// name as a string literal at the call site, and one it cannot see goes unchecked.
//
// No `defaultValue`, deliberately — like every read above. These two feed a
// `createPagedStore`, whose own contract is that a failure throws so `load`/`loadMore` can
// decide what it does to the window they are already holding (they keep the last known
// page and warn). An empty page handed back on a transport failure is indistinguishable
// from a real empty list, which is precisely the "nobody follows this account" lie that
// hid the sandbox refusal this pair was written to fix.
export const getFollowers = (query: FollowListQuery): Promise<FollowPage> =>
  call(accountsContract, 'followers', query);

export const getFollowing = (query: FollowListQuery): Promise<FollowPage> =>
  call(accountsContract, 'following', query);

/**
 * Handle / display-name search within one app, paged the same way.
 *
 * Here for the reason the pair above is: Blabber's Search › People segment used to page a
 * store pointed straight at the `accounts` service, and `accounts` is not Blabber's
 * own service — `IframeHostServer`'s `serviceAllowed` refuses a foreign namespace, so
 * inside the frame that segment answered "No people found" for every query. The facet is
 * the only door an add-on has to a shared service.
 *
 * Public: `citizenid` is withheld by the server's `publicColumns`, so this answers "find
 * the account named X", never "which accounts belong to one player". No `defaultValue`,
 * matching `getFollowers`/`getFollowing` — an empty page on a transport failure is the
 * same lie that hid the sandbox refusal.
 */
export const searchAccounts = (query: AccountSearchQuery) =>
  call(accountsContract, 'search', query);

export const followAccount = (input: {
  app: string;
  follower_account_id: number;
  followee_account_id: number;
}) => call(accountsContract, 'follow', input);

export const unfollowAccount = (input: {
  app: string;
  follower_account_id: number;
  followee_account_id: number;
}) => call(accountsContract, 'unfollow', input);

export const blockAccount = (input: {
  app: string;
  blocker_account_id: number;
  blocked_account_id: number;
}) => call(accountsContract, 'block', input);

export const unblockAccount = (input: {
  app: string;
  blocker_account_id: number;
  blocked_account_id: number;
}) => call(accountsContract, 'unblock', input);

/**
 * Throws on failure, so `createReactionStore`'s `load` keeps the map it holds: a `{}` here
 * would have answered "no reactions" for every target asked about.
 */
export const getReactionsFor = async (target: ReactionTarget) => {
  const reply = await call(accountsContract, 'reactionsFor', target);
  if (!isRecord(reply)) throw malformed('reactionsFor');
  return reply;
};

export const reactToTarget = (payload: {
  app: string;
  account_id: number;
  target_table: string;
  target_id: number;
  emoji: string;
}) => call(accountsContract, 'react', payload);

export const unreactToTarget = (payload: {
  app: string;
  account_id: number;
  target_table: string;
  target_id: number;
  emoji: string;
}) => call(accountsContract, 'unreact', payload);
