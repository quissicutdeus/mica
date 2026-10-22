// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { BankHistory } from '../types';

/**
 * What a `sendMoney` can answer with, and nothing else (MICA-433). A real schema rather than a
 * `responseType`, so the server checks its own reply against it: `transfer()`'s outcome carries
 * both citizenids, and passing it through let anyone turn a $1 send into a number→citizenid
 * lookup. Every reason comes from `Payments`, or is `exceeds_limit`.
 */
const sendMoneyResult = s.union([
  s.object({ ok: s.literal(true) }, { unknownKeys: 'strip' }),
  s.object({ ok: s.literal(false), reason: s.string({ max: 64 }) }, { unknownKeys: 'strip' })
]);

/**
 * Bank has no micaOS table — it reads the banking resource's own export — so every action it
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
    /**
     * The caller's own transaction history and where it came from. The citizenid is the
     * whole predicate. `transactions` is empty both when the account has none and when the
     * banking resource cannot say — `available` is what tells the two apart (MICA-241).
     */
    getTransactions: { input: s.none(), output: responseType<BankHistory>() },

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
      output: sendMoneyResult
    }
  }
});
