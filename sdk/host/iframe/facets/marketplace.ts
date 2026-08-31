import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['marketplace']>>;

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
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('marketplace', marketplace as unknown as Facets['marketplace']);
