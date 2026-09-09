// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { call, callOr } from '../nui/call';
import { bankContract } from '@mica/shared/contracts/bank';
import { invoicesContract } from '@mica/shared/contracts/invoices';
import { writable } from 'svelte/store';
import type { Invoice, InvoiceActionOutcome } from '@mica/shared/types';
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

/**
 * The player's open invoices (MICA-240), and the two things they can do to one.
 *
 * Behind `useBank()` rather than `useAccount()` for the reason `sendMoney` is: paying an
 * invoice moves money, and reading a balance must not imply being able to. The store follows
 * the server — a pay or decline answers the list re-read after the change, and the store
 * replaces itself with that rather than removing a row it hopes is gone.
 */
export const invoices = writable<Invoice[]>([]);
export const invoicesLoaded = writable(false);

export const fetchInvoices = async (): Promise<void> => {
  try {
    const rows = await callOr(invoicesContract, 'getOpen', undefined, [] as Invoice[]);
    invoices.set(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.error('Failed to fetch invoices:', error);
  } finally {
    invoicesLoaded.set(true);
  }
};

const settle = async (action: 'pay' | 'decline', id: number): Promise<InvoiceActionOutcome> => {
  const outcome = await call(invoicesContract, action, { id });
  if (outcome.ok) invoices.set(outcome.invoices);
  return outcome;
};

export const payInvoice = (id: number): Promise<InvoiceActionOutcome> => settle('pay', id);
export const declineInvoice = (id: number): Promise<InvoiceActionOutcome> => settle('decline', id);
