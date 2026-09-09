// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Invoice, InvoiceActionOutcome } from '../types';

/**
 * Invoices (MICA-240): a resource bills a player, and the player pays or declines from the
 * Bank app. Every action here is custom and every one is owner-scoped by the caller's own
 * citizenid; the row id in a payload is never authorization on its own (§2.9), it only picks
 * which of *the caller's* invoices is meant. Nothing a client sends can create one — that is
 * the `SendInvoice` export, server-side, and the reason the service registers no generic
 * action at all.
 */
export const invoicesContract = defineContract({
  id: 'invoices',
  actions: {
    /** The caller's open invoices, newest first. Expired ones are swept out, never listed. */
    getOpen: { input: s.none(), output: responseType<Invoice[]>() },
    /**
     * Pay one. The money moves through `Payments` — to a society through the banking bridge
     * or to a character's bank — with its refund path, and the invoice is claimed *before* the
     * money moves and reopened if it does not, so two taps cannot pay it twice.
     */
    pay: { input: s.object({ id: s.positiveInt() }), output: responseType<InvoiceActionOutcome>() },
    /** Decline one. Terminal; the biller's resource is told. */
    decline: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<InvoiceActionOutcome>()
    }
  }
});
