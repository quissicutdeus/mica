import './inProcess/facets/accounts';
import { guarded } from './guard';
export type { ReactionTarget } from './inProcess/facets/accounts';

/**
 * Social identities — the `@handle`s a player posts under, shared by every social app.
 */
export function useAccounts(appId?: string) {
  return guarded('useAccounts', appId).facets.accounts();
}
