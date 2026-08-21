import './inProcess/facets/marketplace';
import { guarded } from './guard';

/** OS Service Hook for Marketplace. */
export function useMarketplace() {
  return guarded('useMarketplace').facets.marketplace();
}
