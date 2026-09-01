// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['account']>>;

export function account(): Twin {
  return {
    myPhoneNumber: store('account', [], 'myPhoneNumber', ''),
    bankBalance: store('account', [], 'bankBalance', 0),
    transactions: store('account', [], 'transactions', []),
    transactionsLoaded: store('account', [], 'transactionsLoaded', false),
    citizenid: store('account', [], 'citizenid', ''),
    fetchPhoneNumber: fn('account', [], 'fetchPhoneNumber'),
    fetchBalance: fn('account', [], 'fetchBalance'),
    fetchTransactions: fn('account', [], 'fetchTransactions'),
    fetchCitizenId: fn('account', [], 'fetchCitizenId')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('account', account as unknown as Facets['account']);
