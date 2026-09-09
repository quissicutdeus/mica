// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { renderApp } from '@mica/sdk/testing';
import type { Invoice } from '@mica/shared/types';

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
import { invoices, invoicesLoaded } from '../../services/bank';
import { toast } from '../../shell/state/toast';

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

/** What the mocked transport answers, by service action. Reset per test. */
let replies: Record<string, (data?: unknown) => unknown> = {};

beforeEach(() => {
  bankBalance.set(0);
  citizenid.set('TEST1');
  transactions.set([]);
  // Module-scoped, so it survives between tests: without the reset the second test
  // inherits the first one's completed fetch and never sees the loading frame.
  // `renderApp` cannot do this part for you: which stores an app has is its own business.
  transactionsLoaded.set(false);
  invoices.set([]);
  invoicesLoaded.set(false);
  toast.clear();
  replies = {};
  // A banking resource that can answer, so an empty list means "no transactions" and not
  // one of the two other things it can mean (MICA-241) — those get their own cases below.
  // Answered by the transport rather than set on the store, because `onAppForeground`'s
  // fetch replaces the store with whatever the reply says.
  answerHistory({ provider: 'Renewed-Banking', available: true });
  vi.mocked(fetchNui).mockImplementation(async (_action: string, payload?: unknown) => {
    const { action, data } = (payload ?? {}) as { action?: string; data?: unknown };
    return action && replies[action] ? replies[action](data) : null;
  });
});

/** Make the mocked transport answer `getTransactions` with this source and no rows. */
const answerHistory = (source: { provider: string | null; available: boolean }) => {
  replies.getTransactions = () => ({ ...source, transactions: [] });
};

/** The shape of `mockInvoices` in `nui/mocks/registry.ts`, minus what a row does not need. */
const invoice = (
  id: number,
  from_label: string,
  amount: number,
  memo: string | null,
  days: number,
  status: Invoice['status'] = 'active'
): Invoice => ({
  id,
  citizenid: 'TEST1',
  from_label,
  amount,
  memo,
  society: 'mechanic',
  payee: null,
  resource: 'test',
  expires_at: Math.floor(Date.now() / 1000) + days * 86_400,
  paid_at: status === 'paid' ? Math.floor(Date.now() / 1000) : null,
  status,
  created_at: '2026-09-07T18:00:00Z',
  updated_at: '2026-09-07T18:00:00Z'
});

const lsc = invoice(1, 'Los Santos Customs', 450, 'Engine rebuild', 6);
const pillbox = invoice(2, 'Pillbox Medical', 120, null, 2);
const cab = invoice(3, 'Downtown Cab Co.', 35, 'Fare', 1, 'paid');

/** Make `getOpen` answer these rows, the way the server lists a player's open invoices. */
const answerInvoices = (rows: Invoice[]) => {
  replies.getOpen = () => rows;
};

const openInvoices = async () => {
  await fireEvent.click(screen.getByText('Invoices'));
};

/**
 * What a `fetchNui` call asked for: a contracted service action rides the generic `svc`
 * door with its name in the payload; the account's own reads (`getBankBalance`) are the
 * top-level action itself.
 */
const actionOf = (action: string, payload?: unknown): string =>
  (payload as { action?: string } | undefined)?.action ?? action;

/** Every visible Pay button, in row order. */
const payButtons = () => screen.getAllByText('Pay');
const declineButtons = () => screen.getAllByText('Decline');

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

/**
 * MICA-240: the Invoices tab.
 *
 * Driven through the real `useBank()` and the mocked transport rather than a mocked hook,
 * because the thing under test is that the list *follows the reply* — `payInvoice`
 * replacing the store with what the server answered is the store's job, and a mock of it
 * would only prove the mock.
 */
describe('Bank invoices', () => {
  it('renders one row per open invoice, with biller, amount, memo and expiry', async () => {
    answerInvoices([lsc, pillbox]);
    renderApp(Bank, { id: 'bank' });
    await openInvoices();

    expect(await screen.findByText('Los Santos Customs')).toBeTruthy();
    expect(screen.getByText('$450.00')).toBeTruthy();
    expect(screen.getByText('Engine rebuild')).toBeTruthy();
    expect(screen.getByText('Expires in 6 days')).toBeTruthy();
    expect(screen.getByText('Pillbox Medical')).toBeTruthy();
    expect(screen.getByText('$120.00')).toBeTruthy();
    expect(screen.getByText('Expires in 2 days')).toBeTruthy();
    expect(payButtons()).toHaveLength(2);
    expect(declineButtons()).toHaveLength(2);
  });

  it('counts the open invoices on the tab badge', async () => {
    answerInvoices([lsc, pillbox]);
    renderApp(Bank, { id: 'bank' });
    await waitFor(() => expect(get(invoices)).toHaveLength(2));
    expect(screen.getByText('Invoices').parentElement?.textContent).toContain('2');
  });

  it('opens the Invoices tab from the deep link a tapped notification sends', async () => {
    answerInvoices([lsc]);
    renderApp(Bank, { id: 'bank', props: { tab: 'invoices' } });

    expect(await screen.findByText('Los Santos Customs')).toBeTruthy();
    expect(screen.queryByText('Send Money')).toBeNull();
  });

  it('shows a placeholder until the list has been read, then the empty state', async () => {
    // A reply held back until the test lets it go: before it lands nothing is known, so
    // nothing is said either way.
    let release: (rows: Invoice[]) => void = () => {};
    replies.getOpen = () => new Promise<Invoice[]>((resolve) => (release = resolve));
    renderApp(Bank, { id: 'bank' });
    await openInvoices();
    expect(screen.queryByText('No open invoices')).toBeNull();
    expect(get(invoicesLoaded)).toBe(false);

    release([]);
    expect(await screen.findByText('No open invoices')).toBeTruthy();
  });

  it('never lists a paid row, whatever the store holds', async () => {
    answerInvoices([lsc, cab]);
    renderApp(Bank, { id: 'bank' });
    await openInvoices();

    expect(await screen.findByText('Los Santos Customs')).toBeTruthy();
    expect(screen.queryByText('Downtown Cab Co.')).toBeNull();
    expect(payButtons()).toHaveLength(1);
  });

  it('pays through payInvoice with the id, follows the reply and re-reads the card', async () => {
    answerInvoices([lsc, pillbox]);
    replies.pay = (data) => {
      expect(data).toEqual({ id: 1 });
      return { ok: true, invoices: [pillbox] };
    };
    renderApp(Bank, { id: 'bank' });
    await openInvoices();
    await screen.findByText('Los Santos Customs');
    vi.mocked(fetchNui).mockClear();

    await fireEvent.click(payButtons()[0]);

    await waitFor(() => expect(screen.queryByText('Los Santos Customs')).toBeNull());
    expect(screen.getByText('Pillbox Medical')).toBeTruthy();
    const actions = vi
      .mocked(fetchNui)
      .mock.calls.map(([action, payload]) => actionOf(action, payload));
    expect(actions).toContain('pay');
    // The framework moved the money; the card is re-read, never subtracted locally.
    expect(actions).toContain('getBankBalance');
    expect(actions).toContain('getTransactions');
    expect(get(toast)[0]?.message).toBe('Paid $450.00 to Los Santos Customs.');
  });

  it('declines through declineInvoice with the id and follows the reply', async () => {
    answerInvoices([lsc, pillbox]);
    replies.decline = (data) => {
      expect(data).toEqual({ id: 2 });
      return { ok: true, invoices: [lsc] };
    };
    renderApp(Bank, { id: 'bank' });
    await openInvoices();
    await screen.findByText('Pillbox Medical');
    vi.mocked(fetchNui).mockClear();

    await fireEvent.click(declineButtons()[1]);

    await waitFor(() => expect(screen.queryByText('Pillbox Medical')).toBeNull());
    expect(screen.getByText('Los Santos Customs')).toBeTruthy();
    const actions = vi
      .mocked(fetchNui)
      .mock.calls.map(([action, payload]) => actionOf(action, payload));
    expect(actions).toContain('decline');
    // Nothing moved, so nothing is re-read.
    expect(actions).not.toContain('getBankBalance');
    expect(get(toast)[0]?.message).toBe('Declined the invoice from Pillbox Medical.');
  });

  it('toasts the reason when the server refuses, and keeps the row', async () => {
    answerInvoices([lsc]);
    replies.pay = () => ({ ok: false, reason: 'insufficient_funds' });
    renderApp(Bank, { id: 'bank' });
    await openInvoices();
    await screen.findByText('Los Santos Customs');

    await fireEvent.click(payButtons()[0]);

    await waitFor(() =>
      expect(get(toast)[0]?.message).toBe('Your balance is too low for this transfer.')
    );
    expect(get(toast)[0]?.type).toBe('error');
    expect(screen.getByText('Los Santos Customs')).toBeTruthy();
  });

  it('reads an invoice that is gone as "no longer open", whichever way the server says it', async () => {
    answerInvoices([lsc, pillbox]);
    replies.pay = () => ({ ok: false, reason: 'unknown_invoice' });
    replies.decline = () => ({ ok: false, reason: 'not_open' });
    renderApp(Bank, { id: 'bank' });
    await openInvoices();
    await screen.findByText('Los Santos Customs');

    await fireEvent.click(payButtons()[0]);
    await waitFor(() => expect(get(toast)[0]?.message).toBe('This invoice is no longer open.'));

    toast.clear();
    await fireEvent.click(declineButtons()[1]);
    await waitFor(() => expect(get(toast)[0]?.message).toBe('This invoice is no longer open.'));
  });
});
