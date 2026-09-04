// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { call } from '../nui/call';
import { bankContract } from '@mica/shared/contracts/bank';
import type { SendMoneyInput, SendMoneyOutcome } from '@mica/sdk';

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

/**
 * No `defaultValue`: a malformed payload (bad phone, non-positive amount) throws, the
 * same as any other write in this codebase (`fetchNui`'s own doc). Every *business*
 * refusal — insufficient funds, an unreachable recipient, the configured cap — comes back
 * as a normal `{ ok: false, reason }` value instead of an exception, because the caller
 * needs to render the specific reason, not catch a generic error.
 */
export const sendMoney = async (input: SendMoneyInput): Promise<SendMoneyOutcome> => {
  return (await call(bankContract, 'sendMoney', input)) as SendMoneyOutcome;
};
