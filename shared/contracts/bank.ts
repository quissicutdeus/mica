// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Transaction } from '../types';

/** What a `sendMoney` can answer with. Every reason but the last comes from `Payments`. */
type SendMoneyResult = { ok: true } | { ok: false; reason: string };

/**
 * Bank has no gOS table — it reads the banking resource's own export — so every action it
 * answers is custom and every one of them is here.
 *
 * `sendMoney` is the most forgeable request in the phone, which is why the recipient is a
 * **phone number** rather than a citizenid: it is resolved server-side, the way `Phone.ts`
 * resolves who a call reaches, and `Payments.transfer` re-verifies the real balance against
 * the framework's money API rather than trusting anything the client claims. The schema's job
 * is narrower and still worth having — it is what stops a fractional or negative `amount`, or
 * a `note` long enough to be a payload rather than a note, from reaching any of that.
 */
export const bankContract = defineContract({
  id: 'bank',
  actions: {
    /** The caller's own transaction list. The citizenid is the whole predicate. */
    getTransactions: { input: s.none(), output: responseType<Transaction[]>() },

    sendMoney: {
      input: s.object({
        /**
         * Bounded rather than patterned: formats differ per server, and `phoneNumberFrom`
         * has always accepted any non-blank string up to 32 characters. What matters is that
         * it is a string of a sane length before it reaches somebody else's lookup.
         */
        phone: s.string({ min: 1, max: 32 }),
        /**
         * A whole number of dollars. The per-transfer ceiling is a convar the server owner
         * sets, so it stays in the handler — but nothing below one dollar, and nothing
         * fractional, is a transfer anybody meant to make.
         */
        amount: s.positiveInt(),
        /** Player-supplied and never player-facing: it only reaches `transfer`'s server log. */
        note: s.string({ max: 140 }).optional()
      }),
      output: responseType<SendMoneyResult>()
    }
  }
});
