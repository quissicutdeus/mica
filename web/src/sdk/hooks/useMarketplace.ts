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

/** OS Service Hook for Marketplace. */
export function useMarketplace() {
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
