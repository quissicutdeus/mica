import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['clock']>>;

export function clock(): Twin {
  return {
    time: store('clock', [], 'time', { hours: 0, minutes: 0 }),
    is24Hour: store('clock', [], 'is24Hour', false),
    formattedTime: store('clock', [], 'formattedTime', '')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('clock', clock as unknown as Facets['clock']);
