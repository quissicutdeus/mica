import './inProcess/facets/admin';
import { guarded } from './guard';

/**
 * OS Service Hook for the player's admin status.
 */
export function useAdmin() {
  return guarded('useAdmin').facets.admin();
}
