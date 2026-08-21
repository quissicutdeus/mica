import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/marketplace').marketplace>;

const emptyPage = { rows: [], nextCursor: null };

export function marketplace(): Twin {
  return {
    feedStore: store('marketplace', [], 'feedStore', { ...emptyPage }),
    mineStore: store('marketplace', [], 'mineStore', { ...emptyPage }),
    loadFeed: fn('marketplace', [], 'loadFeed'),
    searchListings: fn('marketplace', [], 'searchListings'),
    loadMine: fn('marketplace', [], 'loadMine'),
    viewListing: fn('marketplace', [], 'viewListing'),
    postListing: fn('marketplace', [], 'postListing'),
    markSold: fn('marketplace', [], 'markSold'),
    removeListing: fn('marketplace', [], 'removeListing')
  } as unknown as Twin;
}
registerFacet('marketplace', marketplace);
