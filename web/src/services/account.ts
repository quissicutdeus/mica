// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { call } from '../nui/call';
import { bankContract } from '@mica/shared/contracts/bank';
import type { BankHistory, BankHistorySource, Transaction } from '@mica/shared/types';

// Was a second, divergent Transaction interface declared here. `shared/types.ts` is
// the one contract now — BankingBridge normalizes onto it, so the mock, the UI and
// the server cannot drift apart again.
export type { Transaction } from '@mica/shared/types';

export const bankBalance = writable<number>(0);
export const transactions = writable<Transaction[]>([]);

/**
 * False until the first transaction fetch has come back.
 *
 * Same signal `createCrudStore` exposes, for the same reason: an empty list is not the
 * same statement as "this account has no transactions", and Bank used to make the
 * second one while still waiting for the first.
 */
export const transactionsLoaded = writable(false);

/**
 * Which banking resource the history came from, and whether it can come at all (MICA-241).
 * Starts as "unknown, unavailable" so an empty list before the first fetch is never read as
 * "this script keeps its statements to itself".
 */
export const historySource = writable<BankHistorySource>({ provider: null, available: false });
// No citizenid here, on purpose (MICA-433). The page never needs it — the server knows who
// is asking — and anything held in CEF is readable by an XSS. On ESX it is the player's
// Rockstar licence.
export const myPhoneNumber = writable<string>('555-0199');

export const fetchPhoneNumber = async () => {
  try {
    const phone = await fetchNui<string>('getPhoneNumber', null, { defaultValue: '555-0199' });
    const val = phone || '555-0199';
    myPhoneNumber.set(val);
    return val;
  } catch (error) {
    console.error('Failed to fetch phone number:', error);
    return '555-0199';
  }
};

/**
 * No `defaultValue`: a failed read keeps the last balance rather than showing `$0`, which
 * reads exactly like the bank's answer for an empty account.
 */
export const fetchBalance = async () => {
  try {
    const balance = await fetchNui<number>('getBankBalance', null);
    // A reply that is not a number is no answer either; the old default read it as `0`.
    if (typeof balance === 'number') bankBalance.set(balance);
  } catch (error) {
    console.error('Failed to fetch bank balance:', error);
  }
};

/**
 * `call`, not `callOr`: a failed read keeps the last list and leaves `transactionsLoaded`
 * where it was. Defaulting to an empty history and marking it loaded told the player "no
 * transactions" when the truth was "could not ask"; the next foreground asks again.
 */
export const fetchTransactions = async () => {
  try {
    const empty: BankHistory = { provider: null, available: false, transactions: [] };
    const data = await call(bankContract, 'getTransactions', undefined);
    // A reply that is not the contract's shape — a stale server, a mock answering the old
    // bare array — is treated as the default rather than thrown on: the list stays empty and
    // the source stays "unknown", which is the honest state for an answer this cannot read.
    const history = data && Array.isArray(data.transactions) ? data : empty;
    transactions.set(history.transactions);
    historySource.set({ provider: history.provider, available: history.available });
    transactionsLoaded.set(true);
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
  }
};
