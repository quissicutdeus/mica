import './inProcess/facets/call';
import { guarded } from './guard';

/**
 * OS Service Hook for active phone call management.
 */
export function useCall() {
  return guarded('useCall').facets.call();
}
