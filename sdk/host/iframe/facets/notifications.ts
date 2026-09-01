// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['notifications']>>;

export function notifications(appId?: string): Twin {
  const factoryArgs = [appId];
  return {
    notificationsStore: store('notifications', factoryArgs, 'notificationsStore', []),
    unreadCount: store('notifications', factoryArgs, 'unreadCount', 0),
    totalUnread: store('notifications', factoryArgs, 'totalUnread', 0),
    loaded: store('notifications', factoryArgs, 'loaded', false),
    load: fn('notifications', factoryArgs, 'load'),
    markRead: fn('notifications', factoryArgs, 'markRead'),
    clear: fn('notifications', factoryArgs, 'clear'),
    clearAll: fn('notifications', factoryArgs, 'clearAll')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('notifications', notifications as unknown as Facets['notifications']);
