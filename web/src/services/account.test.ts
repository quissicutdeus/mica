// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bankBalance,
  transactions,
  transactionsLoaded,
  historySource,
  citizenid,
  fetchBalance,
  fetchTransactions,
  fetchCitizenId
} from './account';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. A bare `mockRejectedValue` would skip the
 * defaulting entirely and pass against the very code this file exists to catch.
 */
function refuse<T>(_event: string, _data?: unknown, options?: { defaultValue?: T }): Promise<T> {
  return options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('Player not authenticated'));
}

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

  describe('a failed read is not an answer', () => {
    it('keeps the balance rather than showing $0', async () => {
      bankBalance.set(15000);
      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

      await fetchBalance();

      expect(get(bankBalance)).toBe(15000);
    });

    it('leaves the history unloaded when the first read fails', async () => {
      transactions.set([]);
      transactionsLoaded.set(false);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

      await fetchTransactions();

      // Still loading, not "no transactions": the next foreground asks again.
      expect(get(transactionsLoaded)).toBe(false);
    });

    it('keeps the last history when a later read fails', async () => {
      const tx = [{ amount: 5, time: 1 }] as never;
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce({
        provider: 'okokBanking',
        available: true,
        transactions: tx
      });
      await fetchTransactions();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

      await fetchTransactions();

      expect(get(transactions)).toEqual(tx);
      expect(get(historySource)).toEqual({ provider: 'okokBanking', available: true });
      expect(get(transactionsLoaded)).toBe(true);
    });
  });
});
