// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['phoneNotification']>>;

/**
 * The id is sent, like `lifecycle`'s, but never trusted: the shell pins this facet to the
 * frame's own app (`APP_SCOPED_FACETS`), so whatever is passed here, a notice is filed under
 * the add-on, and `toast` carries only the add-on's own toasts.
 */
export function phoneNotification(appId?: string): Twin {
  // No id, no argument: the wire stays what it was before the facet took one.
  const args = appId === undefined ? [] : [appId];
  return {
    // Sync in-process (returns the new toast's id synchronously); async over the wire.
    sendNotification: fn(
      'phoneNotification',
      args,
      'sendNotification'
    ) as unknown as Twin['sendNotification'],
    dismissNotification: fn('phoneNotification', args, 'dismissNotification'),
    toast: store('phoneNotification', args, 'toast', [])
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('phoneNotification', phoneNotification as unknown as Facets['phoneNotification']);
