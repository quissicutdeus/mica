import {
  feedStore,
  mineStore,
  loadFeed,
  searchListings,
  loadMine,
  viewListing,
  postListing,
  markSold,
  removeListing
} from '../../services/marketplace';
import { assertCapability } from '../capability';

/** OS Service Hook for Marketplace. */
export function useMarketplace() {
  assertCapability('marketplace', 'useMarketplace');
  return {
    feedStore,
    mineStore,
    loadFeed,
    searchListings,
    loadMine,
    viewListing,
    postListing,
    markSold,
    removeListing
  };
}
