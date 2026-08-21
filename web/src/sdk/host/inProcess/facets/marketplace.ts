import { registerFacet } from '../../current';
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
} from '../../../../services/marketplace';

/** OS Service Hook for Marketplace. */
export function marketplace() {
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

registerFacet('marketplace', marketplace);
