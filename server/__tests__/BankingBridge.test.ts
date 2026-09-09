// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { vi, beforeEach, afterEach } from 'vitest';
import {
  BankingBridge,
  normalizeOkokTransactions,
  normalizeRenewedTransactions
} from '../lib/BankingBridge';
import { __setResourceLookup } from '../lib/framework/runtime';

/**
 * These cover the normalization, which is where the risk lives, and — since MICA-241 moved
 * the lookup onto `framework/runtime.ts`'s `resource()` seam — which resource is chosen and
 * what a silent one answers. What a real okokBanking record looks like is still from its
 * docs rather than a running server; `fromOkok`'s comment says so.
 */

/** A record shaped exactly as Renewed-Banking's handleTransaction writes it. */
const renewedRecord = (over: Record<string, unknown> = {}) => ({
  trans_id: 'TR-1',
  title: 'Personal Account',
  amount: 100,
  trans_type: 'deposit',
  receiver: 'John Doe',
  message: 'Paycheck',
  issuer: 'Government',
  time: 1_700_000_000,
  ...over
});

describe('normalizeRenewedTransactions — direction', () => {
  it('reads direction from trans_type, not from the sign of amount', () => {
    // The bug this exists to prevent: Renewed stores every amount as a positive
    // magnitude, so an `amount < 0` check renders withdrawals as credits.
    const [first, second] = normalizeRenewedTransactions([
      renewedRecord({ trans_id: 'in', trans_type: 'deposit', amount: 250 }),
      renewedRecord({ trans_id: 'out', trans_type: 'withdraw', amount: 75 })
    ]);

    expect(first).toMatchObject({ id: 'in', direction: 'in', amount: 250 });
    expect(second).toMatchObject({ id: 'out', direction: 'out', amount: 75 });
  });

  it('keeps amount a positive magnitude even if a resource signs it', () => {
    const [only] = normalizeRenewedTransactions([
      renewedRecord({ trans_type: 'withdraw', amount: -40 })
    ]);

    expect(only.amount).toBe(40);
    expect(only.direction).toBe('out');
  });

  it('is case-insensitive about trans_type', () => {
    const [only] = normalizeRenewedTransactions([renewedRecord({ trans_type: 'WITHDRAW' })]);
    expect(only.direction).toBe('out');
  });

  it('treats an unrecognized trans_type as inbound rather than dropping the row', () => {
    const [only] = normalizeRenewedTransactions([renewedRecord({ trans_type: 'something-else' })]);
    expect(only.direction).toBe('in');
  });
});

describe('normalizeRenewedTransactions — field mapping', () => {
  it('maps every descriptive field onto the shared contract', () => {
    expect(normalizeRenewedTransactions([renewedRecord()])[0]).toEqual({
      id: 'TR-1',
      title: 'Personal Account',
      amount: 100,
      direction: 'in',
      message: 'Paycheck',
      issuer: 'Government',
      receiver: 'John Doe',
      time: 1_700_000_000
    });
  });

  it('accepts a numeric string amount and time', () => {
    const [only] = normalizeRenewedTransactions([renewedRecord({ amount: '250', time: '1700' })]);

    expect(only.amount).toBe(250);
    expect(only.time).toBe(1700);
  });

  it('leaves optional descriptions undefined rather than empty strings', () => {
    const [only] = normalizeRenewedTransactions([
      renewedRecord({ title: '', message: undefined, issuer: null })
    ]);

    expect(only.title).toBeUndefined();
    expect(only.message).toBeUndefined();
    expect(only.issuer).toBeUndefined();
  });

  it('falls back to 0 for an unparseable amount instead of NaN', () => {
    const [only] = normalizeRenewedTransactions([renewedRecord({ amount: 'not-a-number' })]);
    expect(only.amount).toBe(0);
  });

  it('sorts newest first', () => {
    const ids = normalizeRenewedTransactions([
      renewedRecord({ trans_id: 'old', time: 1_000 }),
      renewedRecord({ trans_id: 'new', time: 9_000 }),
      renewedRecord({ trans_id: 'mid', time: 5_000 })
    ]).map((t) => t.id);

    expect(ids).toEqual(['new', 'mid', 'old']);
  });
});

describe('normalizeRenewedTransactions — hostile and absent input', () => {
  it('returns [] for the `false` Renewed sends for an uncached account', () => {
    // Their export returns false, not an empty array. Mapping over that would throw.
    expect(normalizeRenewedTransactions(false)).toEqual([]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nonsense'],
    ['a number', 42],
    ['an object', { transactions: [] }]
  ])('returns [] for %s', (_label, input) => {
    expect(normalizeRenewedTransactions(input)).toEqual([]);
  });

  it('skips non-object entries instead of emitting malformed transactions', () => {
    expect(normalizeRenewedTransactions([null, 'nonsense', 42, renewedRecord()])).toHaveLength(1);
  });
});

/** A record shaped as okokBanking's docs describe `AddTransaction`'s `transactionData`. */
const okokRecord = (over: Record<string, unknown> = {}) => ({
  sender_identifier: 'CID_ME',
  sender_name: 'Ada Lovelace',
  receiver_identifier: 'bank',
  receiver_name: 'Bank',
  value: 500,
  type: 'deposit',
  reason: 'ATM Deposit',
  date: 1_700_000_000,
  ...over
});

describe('normalizeOkokTransactions (MICA-241)', () => {
  it('reads direction from type where it says something, and from the receiver otherwise', () => {
    const rows = normalizeOkokTransactions(
      [
        okokRecord({ type: 'deposit', date: 3 }),
        okokRecord({ type: 'withdraw', date: 2 }),
        okokRecord({ type: 'transfer', receiver_identifier: 'CID_ME', date: 1 }),
        okokRecord({ type: 'transfer', receiver_identifier: 'CID_OTHER', date: 0 })
      ],
      'CID_ME'
    );
    expect(rows.map((r) => r.direction)).toEqual(['in', 'out', 'in', 'out']);
  });

  it('keeps amount a magnitude and maps the descriptive fields', () => {
    const [row] = normalizeOkokTransactions([okokRecord({ value: -250 })], 'CID_ME');
    expect(row).toMatchObject({
      amount: 250,
      title: 'deposit',
      message: 'ATM Deposit',
      issuer: 'Ada Lovelace',
      receiver: 'Bank',
      time: 1_700_000_000
    });
  });

  it('reads a timestamp as seconds, milliseconds or a datetime string, and 0 when absent', () => {
    const times = normalizeOkokTransactions(
      [
        okokRecord({ date: 1_700_000_000 }),
        okokRecord({ date: 1_700_000_000_000 }),
        okokRecord({ date: '2023-11-14T22:13:20Z' }),
        okokRecord({ date: undefined })
      ],
      'CID_ME'
    ).map((r) => r.time);
    expect(times.slice(0, 3).every((t) => t === 1_700_000_000)).toBe(true);
    expect(times[3]).toBe(0);
  });

  it('returns [] for anything that is not an array and skips non-object entries', () => {
    expect(normalizeOkokTransactions(false, 'CID_ME')).toEqual([]);
    expect(normalizeOkokTransactions(null, 'CID_ME')).toEqual([]);
    expect(normalizeOkokTransactions([null, 'x', okokRecord()], 'CID_ME')).toHaveLength(1);
  });
});

/**
 * Which resource answers, and what a detected-but-silent one says. Faked through the
 * `resource()` seam, so the throw FiveM's `exports` proxy raises for an absent resource is
 * the ordinary miss `exposes` swallows.
 */
describe('BankingBridge.getHistory — which resource, and what it can say', () => {
  const useResources = (map: Record<string, unknown>) =>
    __setResourceLookup((name) => {
      if (!(name in map)) throw new Error(`No such export ${name} in resource`);
      return (map as Record<string, any>)[name];
    });

  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => {
    __setResourceLookup();
    vi.restoreAllMocks();
  });

  it('answers nothing, from nobody, when no supported resource is running', () => {
    useResources({});
    expect(BankingBridge.detect()).toBeNull();
    expect(BankingBridge.getHistory('CID_ME')).toEqual({
      provider: null,
      available: false,
      transactions: []
    });
  });

  it('reads Renewed-Banking first, and treats its `false` as an empty account', () => {
    const getAccountTransactions = vi.fn(() => false);
    useResources({
      'Renewed-Banking': { getAccountTransactions },
      okokBanking: { GetPlayerTransactions: () => [okokRecord()] }
    });
    expect(BankingBridge.detect()).toBe('Renewed-Banking');
    expect(BankingBridge.getHistory('CID_ME')).toEqual({
      provider: 'Renewed-Banking',
      available: true,
      transactions: []
    });
    expect(getAccountTransactions).toHaveBeenCalledWith('CID_ME');
  });

  it('reads okokBanking through GetPlayerTransactions with a bounded limit', () => {
    const GetPlayerTransactions = vi.fn(() => [okokRecord()]);
    useResources({ okokBanking: { GetPlayerTransactions } });
    const history = BankingBridge.getHistory('CID_ME');
    expect(history.provider).toBe('okokBanking');
    expect(history.available).toBe(true);
    expect(history.transactions).toHaveLength(1);
    expect(GetPlayerTransactions).toHaveBeenCalledWith('CID_ME', 200);
  });

  it.each([
    ['qb-banking', { 'qb-banking': { GetAccountBalance: () => 0 } }],
    ['ox_banking', { ox_banking: {} }]
  ])('names %s as detected but unable to supply history', (name, map) => {
    useResources(map);
    expect(BankingBridge.detect()).toBe(name);
    expect(BankingBridge.getHistory('CID_ME')).toEqual({
      provider: name,
      available: false,
      transactions: []
    });
  });

  it('answers an empty list under the resource name, not a throw, when the export throws', () => {
    useResources({
      okokBanking: {
        GetPlayerTransactions: () => {
          throw new Error('boom');
        }
      }
    });
    expect(BankingBridge.getHistory('CID_ME')).toEqual({
      provider: 'okokBanking',
      available: true,
      transactions: []
    });
  });
});
