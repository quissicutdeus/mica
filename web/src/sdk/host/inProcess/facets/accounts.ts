import { registerFacet } from '../../current';
import {
  blockAccount,
  createAccount,
  followAccount,
  getAccounts,
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
