// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({
  callerCitizenid: 'CID_CALLER',
  // phone -> { citizenid, source } | undefined
  byPhone: new Map<string, { citizenid: string; source: number }>()
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      src === 1 ? { citizenid: bridge.callerCitizenid, source: 1 } : null,
    getPlayerByPhone: (phone: string) => bridge.byPhone.get(phone) ?? null
  }
}));

const transferMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/Payments', () => ({ transfer: transferMock }));

import '../services/Bank';

/**
 * `Bank.ts`'s own orchestration around `Payments.transfer` — resolving a recipient by
 * phone number, the per-transfer cap, and passing the outcome through unchanged.
 * `transfer()`'s own behavior (insufficient funds, the compensating refund, the stranded
 * case) is already covered end to end in `payments.test.ts`; mocking it here keeps this
 * file about what `sendMoney` adds on top rather than re-proving what it wraps.
 */
describe('bank: sendMoney', () => {
  const SEND = 'gphone:server:bank:sendMoney';

  const call = async (data: unknown, src = 1) => {
    (globalThis as any).source = src;
    (globalThis as any).emitNet = vi.fn();
    const handler = handlers.get(SEND);
    if (!handler) throw new Error('no handler for sendMoney');
    await handler('cb-1', data);
    return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.byPhone.clear();
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
    transferMock.mockResolvedValue({ ok: true, from: 'CID_CALLER', to: 'CID_TARGET', amount: 100 });
  });

  it('resolves the recipient by phone number and forwards to Payments.transfer', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });

    const reply = await call({ phone: '555-0002', amount: 100 });

    expect(transferMock).toHaveBeenCalledWith({
      from: 'CID_CALLER',
      to: 'CID_TARGET',
      amount: 100,
      account: 'bank',
      reason: 'Phone transfer'
    });
    expect(reply).toEqual({ ok: true, from: 'CID_CALLER', to: 'CID_TARGET', amount: 100 });
  });

  it('includes a trimmed, truncated note in the transfer reason', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });

    await call({ phone: '555-0002', amount: 50, note: '  for rent  ' });

    expect(transferMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Phone transfer: for rent' })
    );
  });

  it('refuses an oversized note rather than truncating it into the transfer log', async () => {
    // It used to `slice(0, 140)`, which wrote a log line that was not the one the sender
    // typed and told them the transfer succeeded exactly as asked. The bound is the
    // contract's now, and a note past it is a refusal.
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });

    const reply = await call({ phone: '555-0002', amount: 50, note: 'x'.repeat(500) });

    expect(reply).toMatchObject({ error: expect.stringContaining('note') });
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('still trims a note that fits, so padding cannot pass for length', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });

    await call({ phone: '555-0002', amount: 50, note: '   lunch   ' });

    const [[{ reason }]] = transferMock.mock.calls;
    expect(reason).toBe('Phone transfer: lunch');
  });

  it('refuses an amount over the configured cap without ever calling transfer', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'gphone_bank_transfer_max' ? '1000' : fallback;

    const reply = await call({ phone: '555-0002', amount: 5000 });

    expect(reply).toEqual({ ok: false, reason: 'exceeds_limit' });
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable phone number as recipient_offline, without calling transfer', async () => {
    const reply = await call({ phone: '555-9999', amount: 100 });

    expect(reply).toEqual({ ok: false, reason: 'recipient_offline' });
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('passes through a business refusal from transfer() unchanged', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });
    transferMock.mockResolvedValue({ ok: false, reason: 'insufficient_funds' });

    const reply = await call({ phone: '555-0002', amount: 100 });

    expect(reply).toEqual({ ok: false, reason: 'insufficient_funds' });
  });

  it('rejects a malformed phone number before resolving anything', async () => {
    const reply = await call({ phone: 12345, amount: 100 });

    // The contract refuses a non-string before `phoneNumberFrom` is reached; a blank string
    // is length-legal and still not a number, which is what that helper is still for.
    expect(reply).toMatchObject({ error: expect.stringContaining('phone') });
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount', async () => {
    bridge.byPhone.set('555-0002', { citizenid: 'CID_TARGET', source: 2 });

    const reply = await call({ phone: '555-0002', amount: 0 });

    expect(reply).toMatchObject({ error: expect.stringContaining('amount') });
    expect(transferMock).not.toHaveBeenCalled();
  });
});
