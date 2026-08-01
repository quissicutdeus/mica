import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Transaction } from '@shared/types';

// Was a second, divergent Transaction interface declared here. `shared/types.ts` is
// the one contract now — BankingBridge normalizes onto it, so the mock, the UI and
// the server cannot drift apart again.
export type { Transaction } from '@shared/types';

export const bankBalance = writable<number>(0);
export const transactions = writable<Transaction[]>([]);
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
    const data = await fetchNui<any[]>('getTransactions', null, {
      defaultValue: []
    });
    transactions.set(data);
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
  }
};
