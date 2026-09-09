// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bankBalance,
  transactions,
  historySource,
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
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue('CITIZEN_123');

    const result = await fetchCitizenId();
    expect(result).toBe('CITIZEN_123');
    expect(get(citizenid)).toBe('CITIZEN_123');
  });

  it('fetches bank balance and updates bankBalance store', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(15000);

    await fetchBalance();
    expect(get(bankBalance)).toBe(15000);
  });

  it('fetches transactions and updates the transactions and source stores', async () => {
    const mockTx = [
      { amount: 500, time: 1609459200, title: 'Salary Paycheck', message: 'Direct Deposit' }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      provider: 'okokBanking',
      available: true,
      transactions: mockTx
    });

    await fetchTransactions();
    expect(get(transactions)).toEqual(mockTx);
    expect(get(historySource)).toEqual({ provider: 'okokBanking', available: true });
  });

  it('treats a reply that is not the contract shape as unknown rather than throwing (MICA-241)', async () => {
    // The pre-MICA-241 bare array, which a stale server would still answer with.
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([{ amount: 1, time: 1 }]);

    await fetchTransactions();
    expect(get(transactions)).toEqual([]);
    expect(get(historySource)).toEqual({ provider: null, available: false });
  });
});
