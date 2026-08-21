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
