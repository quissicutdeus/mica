// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  sendMoney,
  invoices,
  invoicesLoaded,
  fetchInvoices,
  payInvoice,
  declineInvoice
} from '../../services/bank';

/**
 * OS Service Hook for sending money. Split from the `account` facet's read side — see
 * `services/bank.ts`'s own doc for why.
 */
export function bank() {
  return {
    sendMoney,
    invoices,
    invoicesLoaded,
    fetchInvoices: () => fetchInvoices(),
    payInvoice: (id: number) => payInvoice(id),
    declineInvoice: (id: number) => declineInvoice(id)
  };
}

registerFacet('bank', bank);
