// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `Facets['bank']` moves money with. MICA-172 — see `./accounts.ts` for why these
 * are declared inside the package rather than borrowed from `services/bank.ts`.
 */

export type SendMoneyOutcome =
  | { ok: true; to: string; amount: number }
  | {
      ok: false;
      reason:
        | 'invalid_amount'
        | 'exceeds_limit'
        | 'same_player'
        | 'payer_offline'
        | 'recipient_offline'
        | 'insufficient_funds'
        | 'debit_failed'
        | 'credit_failed'
        | 'stranded';
    };

export interface SendMoneyInput {
  /** The recipient's phone number. Resolved to a citizenid server-side — never sent as one. */
  phone: string;
  amount: number;
  /** Optional, server-truncated. Reaches nobody but the server's own transfer log. */
  note?: string;
}
