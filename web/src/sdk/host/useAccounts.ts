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
} from '../../services/accounts';

export type { ReactionTarget } from '../../services/accounts';

/**
 * Social identities — the `@handle`s a player posts under, shared by every social app.
 *
 * Distinct from `useAccount` (singular), which is the player's own phone number and bank
 * balance. This is the graph: handles, follows, blocks, reactions. Blabber is the worked
 * example; any app that posts under a handle uses it rather than naming the routes.
 */
export function useAccounts() {
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
