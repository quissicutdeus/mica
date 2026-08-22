import { fetchNui } from '../nui/fetchNui';
import type { Account, FollowStats, ReactionSummary } from '@shared/types';

/**
 * The shared social-identity service, as functions.
 *
 * `gphone_accounts` is core — every social app posts under a handle from it — so its
 * routes are named rows in `shared/routes.ts`, and until now the only way an add-on
 * could reach them was the raw transport. Blabber did exactly that through
 * `useNuiBridge`, which is the hatch MICA-16 closes. No store here on purpose: which
 * accounts are "mine" is per app, and the app holds that.
 */

export interface ReactionTarget {
  app: string;
  target_table: string;
  target_ids: number[];
}

export const getMyAccounts = (app: string) =>
  fetchNui<{ rows: Account[]; limit: number }>(
    'getMyAccounts',
    { app },
    { defaultValue: { rows: [], limit: 3 } }
  );

export const getAccounts = (query: { app: string; handle?: string; limit?: number }) =>
  fetchNui<{ rows: Account[] }>('getAccounts', query, { defaultValue: { rows: [] } });

export const createAccount = (input: { app: string; handle: string; display_name?: string }) =>
  fetchNui<Account>('createAccount', input, undefined);

export const updateAccount = (input: { id: number } & Partial<Account>) =>
  fetchNui('updateAccount', input, undefined);

export const getFollowStats = (input: {
  app: string;
  account_id: number;
  viewer_account_id?: number;
}) =>
  fetchNui<FollowStats>('getFollowStats', input, {
    defaultValue: {
      followers: 0,
      following: 0,
      followedByMe: false,
      blockedByMe: false
    }
  });

/**
 * The two lists behind those counts, paged.
 *
 * Here rather than as a bare `createPagedStore('getFollowers')` inside Blabber, because
 * Blabber is an add-on now: `sdk/host/iframe/fetchNui.ts` refuses a named NUI action from
 * inside the sandbox, and the generic service route is pinned to the app's own namespace
 * (`IframeHostServer`'s `serviceAllowed`) — so the only door an add-on has to a *shared*
 * service is its enumerated facet, which is this module. Public, like the counts: no
 * viewer identity is sent, because these read the same whoever is looking.
 */
export interface FollowPage {
  rows: Account[];
  nextCursor: number | null;
}

export interface FollowListQuery {
  app: string;
  account_id: number;
  cursor?: number;
  limit?: number;
}

// Two literal calls rather than one helper taking the action name, for the reason
// `toggleFollow` gives: `server/__tests__/routes.test.ts` scans for the action name as a
// string literal at the call site, and a route it cannot see is reported as dead weight.
//
// No `defaultValue`, deliberately — unlike every read above. These two feed a
// `createPagedStore`, whose own contract is that a failure throws so `load`/`loadMore` can
// decide what it does to the window they are already holding (they keep the last known
// page and warn). An empty page handed back on a transport failure is indistinguishable
// from a real empty list, which is precisely the "nobody follows this account" lie that
// hid the sandbox refusal this pair was written to fix.
export const getFollowers = (query: FollowListQuery) =>
  fetchNui<FollowPage>('getFollowers', query, undefined);

export const getFollowing = (query: FollowListQuery) =>
  fetchNui<FollowPage>('getFollowing', query, undefined);

export const followAccount = (input: {
  app: string;
  follower_account_id: number;
  followee_account_id: number;
}) => fetchNui('followAccount', input, undefined);

export const unfollowAccount = (input: {
  app: string;
  follower_account_id: number;
  followee_account_id: number;
}) => fetchNui('unfollowAccount', input, undefined);

export const blockAccount = (input: {
  app: string;
  blocker_account_id: number;
  blocked_account_id: number;
}) => fetchNui('blockAccount', input, undefined);

export const unblockAccount = (input: {
  app: string;
  blocker_account_id: number;
  blocked_account_id: number;
}) => fetchNui('unblockAccount', input, undefined);

export const getReactionsFor = (target: ReactionTarget) =>
  fetchNui<Record<number, ReactionSummary>>('getReactionsFor', target, { defaultValue: {} });

export const reactToTarget = (payload: {
  app: string;
  account_id: number;
  target_table: string;
  target_id: number;
  emoji: string;
}) => fetchNui('reactToTarget', payload, undefined);

export const unreactToTarget = (payload: {
  app: string;
  account_id: number;
  target_table: string;
  target_id: number;
  emoji: string;
}) => fetchNui('unreactToTarget', payload, undefined);
