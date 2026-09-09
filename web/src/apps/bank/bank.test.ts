// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';

// jsdom has no Web Animations API and `SendMoneyModal`'s `transition:fade` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));
import { fetchNui } from '../../nui/fetchNui';

import Bank from './index.svelte';
import { transactions, transactionsLoaded, bankBalance, citizenid } from '../../services/account';

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
  // `renderApp` cannot do this part for you: which stores an app has is its own business.
  transactionsLoaded.set(false);
  // A banking resource that can answer, so an empty list means "no transactions" and not
  // one of the two other things it can mean (MICA-241) — those get their own cases below.
  // Answered by the transport rather than set on the store, because `onAppForeground`'s
  // fetch replaces the store with whatever the reply says.
  answerHistory({ provider: 'Renewed-Banking', available: true });
});

/** Make the mocked transport answer `getTransactions` with this source and no rows. */
const answerHistory = (source: { provider: string | null; available: boolean }) => {
  vi.mocked(fetchNui).mockImplementation(async (_action: string, payload?: unknown) =>
    (payload as { action?: string } | undefined)?.action === 'getTransactions'
      ? { ...source, transactions: [] }
      : null
  );
};

describe('Bank', () => {
  it('says so when there are no transactions', async () => {
    const { findByText } = renderApp(Bank, { id: 'bank' });
    // Awaited, because "no transactions" is only true once the fetch has come back.
    expect(await findByText('No transactions')).toBeTruthy();
  });

  /**
   * MICA-241. An empty list from a script that publishes no history export used to render
   * as "No transactions", which told a player on qb-banking that their account had none.
   */
  it('names the script when it is detected but keeps its statements to itself', async () => {
    answerHistory({ provider: 'qb-banking', available: false });

    const { findByText, queryByText } = renderApp(Bank, { id: 'bank' });

    expect(await findByText('History not available')).toBeTruthy();
    expect(queryByText(/qb-banking does not share/)).toBeTruthy();
    expect(queryByText('No transactions')).toBeNull();
  });

  it('says no supported banking resource is running when none was detected', async () => {
    answerHistory({ provider: null, available: false });

    const { findByText, queryByText } = renderApp(Bank, { id: 'bank' });

    expect(await findByText('History not available')).toBeTruthy();
    expect(queryByText(/No supported banking resource/)).toBeTruthy();
    expect(queryByText('No transactions')).toBeNull();
  });

  it('shows a placeholder rather than the empty state while the fetch is in flight', () => {
    // The distinction the skeleton exists for: on the first frame Bank does not yet know
    // whether this account has transactions, and it used to state that it had none.
    const { queryByText, getByText } = renderApp(Bank, { id: 'bank' });
    expect(queryByText('No transactions')).toBeNull();
    expect(getByText('Loading')).toBeTruthy();
  });

  it('lists transactions when there are some', () => {
    transactions.set([
      { id: 't1', title: 'Job', message: 'Salary', amount: 100, direction: 'in', time: 1 }
    ] as never);

    const { queryByText } = renderApp(Bank, { id: 'bank' });
    expect(queryByText('No transactions')).toBeNull();
  });

  it('opens Send Money from the app itself — proving the bank permission is wired, not just declared', async () => {
    // `SendMoneyModal.test.ts` covers the modal's own behavior in isolation, with
    // `useBank` mocked. This is the one check that `bank/manifest.ts` declaring `bank`
    // actually resolves inside Bank's real render context — a missing or misspelled
    // permission throws `AppPermissionError` at construction, before anything renders.
    renderApp(Bank, { id: 'bank' });

    await fireEvent.click(screen.getByText('Send Money'));
    expect(screen.getByPlaceholderText("Recipient's phone number")).toBeTruthy();
  });
});
