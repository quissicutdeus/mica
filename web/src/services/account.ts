// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { callOr } from '../nui/call';
import { bankContract } from '@mica/shared/contracts/bank';
import type { Transaction } from '@mica/shared/types';

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
export const citizenid = writable<string>('');
export const myPhoneNumber = writable<string>('555-0199');

export const fetchCitizenId = async () => {
  try {
    const id = await fetchNui<string>('getCitizenId', null, { defaultValue: '' });
    citizenid.set(id);
    return id;
  } catch (error) {
    console.error('Failed to fetch citizenid:', error);
    return '';
  }
};

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

export const fetchBalance = async () => {
  try {
    const balance = await fetchNui<number>('getBankBalance', null, { defaultValue: 0 });
    bankBalance.set(balance);
  } catch (error) {
    console.error('Failed to fetch bank balance:', error);
  }
};

export const fetchTransactions = async () => {
  try {
    const data = await callOr(bankContract, 'getTransactions', undefined, [] as Transaction[]);
    transactions.set(data);
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
  } finally {
    transactionsLoaded.set(true);
  }
};
