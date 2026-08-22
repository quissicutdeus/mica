import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/notificationSettings').notificationSettings>
>;

export function notificationSettings(): Twin {
  return {
    toastsEnabled: store('notificationSettings', [], 'toastsEnabled', true),
    notificationSoundEnabled: store('notificationSettings', [], 'notificationSoundEnabled', true),
    badgesEnabled: store('notificationSettings', [], 'badgesEnabled', true)
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet(
  'notificationSettings',
  notificationSettings as unknown as Facets['notificationSettings']
);
