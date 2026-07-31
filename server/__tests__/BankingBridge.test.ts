import { describe, it, expect } from 'vitest';
import { normalizeRenewedTransactions } from '../lib/BankingBridge';

/**
 * These cover the normalization, which is where the risk lives. The resource lookup
 * itself (`exports['Renewed-Banking']?.getAccountTransactions`) is two lines and is
 * NOT covered: `exports` is a FiveM runtime global that Vite shadows with a
 * per-module object, so it cannot be faked from a test. Verifying that half needs a
 * running server.
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
