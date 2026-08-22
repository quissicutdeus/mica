import { registerFacet } from '../../current';
import {
  blockAccount,
  createAccount,
  followAccount,
  getAccounts,
  getFollowers,
  getFollowing,
  getFollowStats,
  getMyAccounts,
  getReactionsFor,
  reactToTarget,
  unblockAccount,
  unfollowAccount,
  unreactToTarget,
  updateAccount
} from '../../../../services/accounts';

export type { ReactionTarget } from '../../../../services/accounts';

/** Implementation of the `useAccounts` facet — see the `useAccounts` hook doc for the usage contract. */
export function accounts() {
  return {
    getMyAccounts,
    getAccounts,
    createAccount,
    updateAccount,
    getFollowStats,
    getFollowers,
    getFollowing,
    followAccount,
    unfollowAccount,
    blockAccount,
    unblockAccount,
    getReactionsFor,
    reactToTarget,
    unreactToTarget
  };
}

registerFacet('accounts', accounts);
