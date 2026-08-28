import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/media').media>>;

export function media(): Twin {
  return {
    media: store('media', [], 'media', []),
    capturePhoto: fn('media', [], 'capturePhoto'),
    deletePhoto: fn('media', [], 'deletePhoto'),
    dropNearby: fn('media', [], 'dropNearby'),
    fullMedia: fn('media', [], 'fullMedia')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('media', media as unknown as Facets['media']);
