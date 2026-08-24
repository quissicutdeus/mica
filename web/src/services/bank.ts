import { fetchNui } from '../nui/fetchNui';

/**
 * Sending money, kept out of `services/account.ts` on purpose.
 *
 * `account.ts` backs `useAccount()`, which any add-on can reach by declaring the
 * `account` permission — the one every balance-displaying app would ask for. Bundling a
 * spend action in there would hand every one of them money-movement too. This file backs
 * `useBank()` instead, gated on its own `bank` permission, so a player is told
 * specifically when an app can move their money rather than inferring it from "reads my
 * balance."
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

/**
 * No `defaultValue`: a malformed payload (bad phone, non-positive amount) throws, the
 * same as any other write in this codebase (`fetchNui`'s own doc). Every *business*
 * refusal — insufficient funds, an unreachable recipient, the configured cap — comes back
 * as a normal `{ ok: false, reason }` value instead of an exception, because the caller
 * needs to render the specific reason, not catch a generic error.
 */
export const sendMoney = async (input: SendMoneyInput): Promise<SendMoneyOutcome> => {
  return await fetchNui<SendMoneyOutcome>('sendMoney', input);
};
