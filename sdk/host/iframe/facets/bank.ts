// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['bank']>>;

export function bank(): Twin {
  return {
    sendMoney: fn('bank', [], 'sendMoney'),
    invoices: store('bank', [], 'invoices', []),
    invoicesLoaded: store('bank', [], 'invoicesLoaded', false),
    fetchInvoices: fn('bank', [], 'fetchInvoices'),
    payInvoice: fn('bank', [], 'payInvoice'),
    declineInvoice: fn('bank', [], 'declineInvoice')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable for the two invoice stores (MICA-240). This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('bank', bank as unknown as Facets['bank']);
