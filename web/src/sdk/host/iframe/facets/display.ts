import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';
import { constants } from '../constants';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/display').display>>;

export function display(): Twin {
  const c = constants().display;

  return {
    displaySize: store('display', [], 'displaySize', c.displaySizeDefault ?? 50),
    setDisplaySize: fn('display', [], 'setDisplaySize'),
    displaySizeDefault: c.displaySizeDefault,
    phoneScale: store('display', [], 'phoneScale', 1),
    phoneBox: store('display', [], 'phoneBox', { width: 0, height: 0 }),
    isSizeLimited: store('display', [], 'isSizeLimited', false),

    homeGridColumns: store('display', [], 'homeGridColumns', c.homeGridColumnsDefault ?? 4),
    homeGridRows: store('display', [], 'homeGridRows', c.homeGridRowsDefault ?? 5),
    homeGridColumnsDefault: c.homeGridColumnsDefault,
    homeGridColumnsMin: c.homeGridColumnsMin,
    homeGridColumnsMax: c.homeGridColumnsMax,
    homeGridRowsDefault: c.homeGridRowsDefault,
    homeGridRowsMin: c.homeGridRowsMin,
    homeGridRowsMax: c.homeGridRowsMax,

    setHomeGridSize: fn('display', [], 'setHomeGridSize')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('display', display as unknown as Facets['display']);
