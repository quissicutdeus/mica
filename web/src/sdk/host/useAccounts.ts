import './inProcess/facets/accounts';
import { guarded } from './guard';
export type { ReactionTarget } from './inProcess/facets/accounts';

/**
 * Social identities — the `@handle`s a player posts under, shared by every social app.
 *
 * Distinct from `useAccount` (singular), which is the player's own phone number and bank
 * balance. This is the graph: handles, follows, blocks, reactions. Blabber is the worked
 * example; any app that posts under a handle uses it rather than naming the routes.
 */
export function useAccounts(appId?: string) {
  return guarded('useAccounts', appId).facets.accounts();
}
