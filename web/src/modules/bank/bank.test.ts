import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';

vi.mock('../../utils/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));

import Bank from './index.svelte';
import { transactions, bankBalance, citizenid } from '../../store/account';

/**
 * Bank's empty state.
 *
 * Tested here rather than in Playwright because the browser mock always returns
 * transactions, so an e2e for this passes whether the empty branch exists or not — it
 * did, when checked against the unfixed version.
 *
 * Before the fix a player with a broken banking bridge saw a "Recent Transactions"
 * heading with nothing underneath and no indication anything was wrong.
 */

beforeEach(() => {
  bankBalance.set(0);
  citizenid.set('TEST1');
  transactions.set([]);
});

describe('Bank', () => {
  it('says so when there are no transactions', () => {
    const { getByText } = render(Bank, { props: { onback: () => {} } });
    expect(getByText('No transactions')).toBeTruthy();
  });

  it('lists transactions when there are some', () => {
    transactions.set([
      { id: 't1', title: 'Job', message: 'Salary', amount: 100, direction: 'in', time: 1 }
    ] as never);

    const { queryByText } = render(Bank, { props: { onback: () => {} } });
    expect(queryByText('No transactions')).toBeNull();
  });
});
