import { registerFacet } from '../../current';
import { fn } from './_shared';

export type { ReactionTarget } from '../../inProcess/facets/accounts';

type Twin = ReturnType<typeof import('../../inProcess/facets/accounts').accounts>;

export function accounts(): Twin {
  return {
    getMyAccounts: fn('accounts', [], 'getMyAccounts'),
    getAccounts: fn('accounts', [], 'getAccounts'),
    createAccount: fn('accounts', [], 'createAccount'),
    updateAccount: fn('accounts', [], 'updateAccount'),
    getFollowStats: fn('accounts', [], 'getFollowStats'),
    getFollowers: fn('accounts', [], 'getFollowers'),
    getFollowing: fn('accounts', [], 'getFollowing'),
    followAccount: fn('accounts', [], 'followAccount'),
    unfollowAccount: fn('accounts', [], 'unfollowAccount'),
    blockAccount: fn('accounts', [], 'blockAccount'),
    unblockAccount: fn('accounts', [], 'unblockAccount'),
    getReactionsFor: fn('accounts', [], 'getReactionsFor'),
    reactToTarget: fn('accounts', [], 'reactToTarget'),
    unreactToTarget: fn('accounts', [], 'unreactToTarget')
  } as unknown as Twin;
}
registerFacet('accounts', accounts);
