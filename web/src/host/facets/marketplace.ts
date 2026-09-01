// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
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
