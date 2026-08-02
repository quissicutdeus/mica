import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));

import Bank from './index.svelte';
import { transactions, transactionsLoaded, bankBalance, citizenid } from '../../services/account';
import { currentApp } from '../../shell/state/navigation';

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
  // Module-scoped, so it survives between tests: without the reset the second test
  // inherits the first one's completed fetch and never sees the loading frame.
  transactionsLoaded.set(false);
  // Bank fetches on `onAppForeground`, so it has to actually be the foreground app.
  // Rendering the component in isolation is not enough — which is the point: it reloads
  // per visit rather than once per session.
  currentApp.set({ id: 'bank', props: {} });
});

describe('Bank', () => {
  it('says so when there are no transactions', async () => {
    const { findByText } = render(Bank, { props: { onback: () => {} } });
    // Awaited, because "no transactions" is only true once the fetch has come back.
    expect(await findByText('No transactions')).toBeTruthy();
  });

  it('shows a placeholder rather than the empty state while the fetch is in flight', () => {
    // The distinction the skeleton exists for: on the first frame Bank does not yet know
    // whether this account has transactions, and it used to state that it had none.
    const { queryByText, getByText } = render(Bank, { props: { onback: () => {} } });
    expect(queryByText('No transactions')).toBeNull();
    expect(getByText('Loading')).toBeTruthy();
  });

  it('lists transactions when there are some', () => {
    transactions.set([
      { id: 't1', title: 'Job', message: 'Salary', amount: 100, direction: 'in', time: 1 }
    ] as never);

    const { queryByText } = render(Bank, { props: { onback: () => {} } });
    expect(queryByText('No transactions')).toBeNull();
  });
});
