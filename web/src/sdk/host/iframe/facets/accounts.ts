import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

export type { ReactionTarget } from '../../../vocabulary/accounts';

type Twin = AsTwin<ReturnType<Facets['accounts']>>;

export function accounts(): Twin {
  return {
    getMyAccounts: fn('accounts', [], 'getMyAccounts'),
    getAccounts: fn('accounts', [], 'getAccounts'),
    createAccount: fn('accounts', [], 'createAccount'),
    updateAccount: fn('accounts', [], 'updateAccount'),
    getFollowStats: fn('accounts', [], 'getFollowStats'),
    getFollowers: fn('accounts', [], 'getFollowers'),
    getFollowing: fn('accounts', [], 'getFollowing'),
    searchAccounts: fn('accounts', [], 'searchAccounts'),
    followAccount: fn('accounts', [], 'followAccount'),
    unfollowAccount: fn('accounts', [], 'unfollowAccount'),
    blockAccount: fn('accounts', [], 'blockAccount'),
    unblockAccount: fn('accounts', [], 'unblockAccount'),
    getReactionsFor: fn('accounts', [], 'getReactionsFor'),
    reactToTarget: fn('accounts', [], 'reactToTarget'),
    unreactToTarget: fn('accounts', [], 'unreactToTarget')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('accounts', accounts);
