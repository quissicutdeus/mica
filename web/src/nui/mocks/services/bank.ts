// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Type-only: `services/bank.ts` imports `fetchNui`, which imports this file's own
// transport — a value import here would be a real import cycle, a type-only one is
// erased before anything runs.
import type { SendMoneyOutcome } from '@mica/sdk';
import type { BankHistory, Invoice, InvoiceActionOutcome, Transaction } from '@mica/shared/types';
import type { MockHandler } from '../registry';

/** Mutated by `sendMoney` below, so a browser session sees its own transfer reflected. */
let mockBankBalance = 12450;
/**
 * Two open invoices and one already paid (MICA-240): the paid one proves the list is the
 * open ones only, the way `findOpen` reads it on the server.
 */
const mockInvoices: Invoice[] = [
  {
    id: 1,
    citizenid: 'my-id',
    from_label: 'Los Santos Customs',
    amount: 450,
    memo: 'Engine rebuild',
    society: 'mechanic',
    payee: null,
    resource: 'lsc-garage',
    expires_at: Math.floor(Date.now() / 1000) + 6 * 86_400,
    paid_at: null,
    status: 'active',
    created_at: '2026-09-07T18:00:00Z',
    updated_at: '2026-09-07T18:00:00Z'
  },
  {
    id: 2,
    citizenid: 'my-id',
    from_label: 'Pillbox Medical',
    amount: 120,
    memo: null,
    society: 'ambulance',
    payee: null,
    resource: 'pillbox',
    expires_at: Math.floor(Date.now() / 1000) + 2 * 86_400,
    paid_at: null,
    status: 'active',
    created_at: '2026-09-06T09:30:00Z',
    updated_at: '2026-09-06T09:30:00Z'
  },
  {
    id: 3,
    citizenid: 'my-id',
    from_label: 'Downtown Cab Co.',
    amount: 35,
    memo: 'Fare',
    society: 'taxi',
    payee: null,
    resource: 'taxi',
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    paid_at: 1_757_100_000,
    status: 'paid',
    created_at: '2026-09-05T12:00:00Z',
    updated_at: '2026-09-05T12:10:00Z'
  }
];

const mockBankTransactions: Transaction[] = [
  {
    id: 'mock-1',
    title: 'Store',
    message: 'Store Purchase',
    amount: 45,
    direction: 'out',
    time: Math.floor(Date.now() / 1000)
  },
  {
    id: 'mock-2',
    title: 'Job',
    message: 'Salary',
    amount: 1500,
    direction: 'in',
    time: Math.floor(Date.now() / 1000) - 86400
  },
  {
    id: 'mock-3',
    title: 'Transfer',
    message: 'Transfer',
    amount: 200,
    direction: 'out',
    time: Math.floor(Date.now() / 1000) - 172800
  }
];

export const mocks: Record<string, MockHandler> = {
  getBankBalance: () => mockBankBalance,
  // Shaped exactly like BankingBridge output: positive magnitudes with an explicit
  // direction. The previous mock used signed amounts, which no banking resource
  // produces — so red/green rendering worked here and was wrong in game.
  /**
   * Invoices (MICA-240). The mock plays the server's state machine: a pay or decline claims
   * the row out of `active` and answers the re-read open list, a second attempt on the same
   * id is `not_open`, and an unknown id is `unknown_invoice`. Paying debits the mock balance
   * so the Bank card moves the way it does in game.
   */
  'invoices:getOpen': (): Invoice[] => mockInvoices.filter((i) => i.status === 'active'),
  'invoices:pay': (payload?: { id?: number }): InvoiceActionOutcome => {
    const invoice = mockInvoices.find((i) => i.id === payload?.id);
    if (!invoice) return { ok: false, reason: 'unknown_invoice' };
    if (invoice.status !== 'active') return { ok: false, reason: 'not_open' };
    if (invoice.amount > mockBankBalance) return { ok: false, reason: 'insufficient_funds' };
    invoice.status = 'paid';
    invoice.paid_at = Math.floor(Date.now() / 1000);
    mockBankBalance -= invoice.amount;
    mockBankTransactions.unshift({
      id: `mock-invoice-${invoice.id}`,
      title: 'Invoice',
      message: `Paid ${invoice.from_label}${invoice.memo ? `: ${invoice.memo}` : ''}`,
      amount: invoice.amount,
      direction: 'out',
      time: invoice.paid_at
    });
    return { ok: true, invoices: mockInvoices.filter((i) => i.status === 'active') };
  },
  'invoices:decline': (payload?: { id?: number }): InvoiceActionOutcome => {
    const invoice = mockInvoices.find((i) => i.id === payload?.id);
    if (!invoice) return { ok: false, reason: 'unknown_invoice' };
    if (invoice.status !== 'active') return { ok: false, reason: 'not_open' };
    invoice.status = 'declined';
    return { ok: true, invoices: mockInvoices.filter((i) => i.status === 'active') };
  },

  // The source is named the way the server names it (MICA-241): the mock stands in for a
  // server running Renewed-Banking, the one resource whose history is verified against source.
  'bank:getTransactions': (): BankHistory => ({
    provider: 'Renewed-Banking',
    available: true,
    transactions: mockBankTransactions
  }),
  /**
   * Mirrors `server/services/Bank.ts`'s `sendMoney` refusal reasons, so the same UI
   * copy in `SendMoneyModal.svelte` is exercised in a browser as in game. `867-5309` is
   * this mock's own `getPhoneNumber` — dialing it is a self-transfer, same as the real
   * `same_player` check. `000-0000` is the one number nobody is ever reachable at.
   */
  'bank:sendMoney': (payload?: {
    phone?: string;
    amount?: number;
    note?: string;
  }): SendMoneyOutcome => {
    const phone = typeof payload?.phone === 'string' ? payload.phone.trim() : '';
    const amount = Number(payload?.amount);

    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid_amount' };
    }
    if (amount > 50_000) {
      return { ok: false, reason: 'exceeds_limit' };
    }
    if (phone === '867-5309') {
      return { ok: false, reason: 'same_player' };
    }
    if (!phone || phone === '000-0000') {
      return { ok: false, reason: 'recipient_offline' };
    }
    if (amount > mockBankBalance) {
      return { ok: false, reason: 'insufficient_funds' };
    }

    mockBankBalance -= amount;
    mockBankTransactions.unshift({
      id: `mock-transfer-${Date.now()}`,
      title: 'Transfer',
      message: payload?.note ? `Sent to ${phone}: ${payload.note}` : `Sent to ${phone}`,
      amount,
      direction: 'out',
      time: Math.floor(Date.now() / 1000)
    });

    return { ok: true, to: phone, amount };
  }
};
