import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/phoneNotification').phoneNotification>
>;

export function phoneNotification(): Twin {
  return {
    // Sync in-process (returns the new toast's id synchronously); async over the wire.
    sendNotification: fn(
      'phoneNotification',
      [],
      'sendNotification'
    ) as unknown as Twin['sendNotification'],
    dismissNotification: fn('phoneNotification', [], 'dismissNotification'),
    toast: store('phoneNotification', [], 'toast', [])
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('phoneNotification', phoneNotification as unknown as Facets['phoneNotification']);
