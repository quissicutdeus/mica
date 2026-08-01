import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bankBalance,
  transactions,
  citizenid,
  fetchBalance,
  fetchTransactions,
  fetchCitizenId
} from './account';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('account store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches citizen ID and updates citizenid store', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue('CITIZEN_123' as any);

    const result = await fetchCitizenId();
    expect(result).toBe('CITIZEN_123');
    expect(get(citizenid)).toBe('CITIZEN_123');
  });

  it('fetches bank balance and updates bankBalance store', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(15000 as any);

    await fetchBalance();
    expect(get(bankBalance)).toBe(15000);
  });

  it('fetches transactions and updates transactions store', async () => {
    const mockTx = [
      { amount: 500, time: 1609459200, title: 'Salary Paycheck', message: 'Direct Deposit' }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockTx as any);

    await fetchTransactions();
    expect(get(transactions)).toEqual(mockTx);
  });
});
