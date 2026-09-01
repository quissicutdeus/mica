// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['mail']>>;

export const unreadMailCount = store('mail', [], 'unreadMailCount', 0);

export function mail(): Twin {
  return {
    mailStore: store('mail', [], 'mailStore', []),
    unreadMailCount,
    deleteMail: fn('mail', [], 'deleteMail'),
    markAsRead: fn('mail', [], 'markAsRead'),
    archiveMail: fn('mail', [], 'archiveMail'),
    addReceivedMail: fn('mail', [], 'addReceivedMail')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('mail', mail as unknown as Facets['mail']);
