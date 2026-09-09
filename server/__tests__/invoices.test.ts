// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers, localHandlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  // Every handler per name, not the last: `onResourceStop` is registered by several modules.
  const local = new Map<string, Function[]>();
  const previousOnNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    local.set(event, [...(local.get(event) ?? []), handler]);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return {
    dbMock: {
      query: vi.fn(async (): Promise<unknown> => []),
      insert: vi.fn(async () => 1),
      update: vi.fn(async () => true),
      scalar: vi.fn(),
      single: vi.fn(async (): Promise<unknown> => null)
    },
    handlers: captured,
    localHandlers: local
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({
  online: new Map<string, number>([['CID_PAYER', 1]])
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) => {
      const entry = [...bridge.online].find(([, s]) => s === src);
      return entry ? { citizenid: entry[0], source: src, setMeta: () => {} } : null;
    },
    getCitizenId: (src: number) => [...bridge.online].find(([, s]) => s === src)?.[0] ?? null,
    getSourceByCitizenId: (cid: string) => bridge.online.get(cid) ?? null,
    getSourcesByCitizenId: (cids: string[]) =>
      new Map(cids.filter((c) => bridge.online.has(c)).map((c) => [c, bridge.online.get(c)!])),
    getAllPlayers: () => ({}),
    registerUsableItem: () => {}
  }
}));

const payments = vi.hoisted(() => ({
  payToSociety: vi.fn(),
  transfer: vi.fn()
}));
vi.mock('../lib/Payments', () => payments);

const directory = vi.hoisted(() => ({
  resolve: vi.fn(async (cid: string) => ({ citizenid: cid }))
}));
vi.mock('../lib/PlayerDirectory', () => directory);

import '../services';
import {
  __resetInvoiceCallbacks,
  createInvoice,
  expireDueInvoices,
  expiryDays
} from '../services/Invoices';
import { registerPublicApi } from '../lib/publicApi';
import { publishedExport, __resetExportRateLimits } from '../lib/exports';
import { __resetRateLimits } from '../lib/rateLimit';
import type { Invoice } from '@mica/shared/types';

/**
 * MICA-240. What matters here is the money discipline around a row a client can only ever
 * point at: the invoice is claimed *before* `Payments` runs and reopened if the payment does
 * not land, the claim's own `status = 'active'` predicate is what makes a second tap find
 * nothing, and nothing a client sends can create, edit or delete one.
 */

const NOW = 1_800_000_000;
const OPEN: Invoice = {
  id: 7,
  citizenid: 'CID_PAYER',
  from_label: 'Los Santos Customs',
  amount: 450,
  memo: 'Engine work',
  society: 'mechanic',
  payee: null,
  resource: 'lsc-garage',
  expires_at: NOW + 3600,
  paid_at: null,
  status: 'active',
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z'
};

const fire = async (action: string, data: unknown, src = 1) => {
  (globalThis as any).source = src;
  const handler = handlers.get(`mica:server:invoices:${action}`);
  if (!handler) throw new Error(`no handler for invoices:${action}`);
  await handler('cb-1', data);
  const calls = (globalThis.emitNet as any).mock.calls as unknown[][];
  return calls.find(([event]) => event === `mica:client:invoices:${action}`)?.[3];
};

const updates = () =>
  dbMock.update.mock.calls.map(([sql, params]) => [String(sql).replace(/\s+/g, ' '), params]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).GetConvarInt = (_name: string, fallback: number) => fallback;
  __resetRateLimits();
  __resetExportRateLimits();
  __resetInvoiceCallbacks();
  dbMock.single.mockResolvedValue({ ...OPEN });
  dbMock.query.mockResolvedValue([]);
  dbMock.update.mockResolvedValue(true);
  dbMock.insert.mockResolvedValue(7);
  payments.payToSociety.mockResolvedValue({
    ok: true,
    from: 'CID_PAYER',
    to: 'society:mechanic',
    amount: 450
  });
  payments.transfer.mockResolvedValue({
    ok: true,
    from: 'CID_PAYER',
    to: 'CID_BILLER',
    amount: 450
  });
});

describe('what a client can reach', () => {
  it('registers the three contracted actions and no generic CRUD', () => {
    const names = [...handlers.keys()].filter((e) => e.startsWith('mica:server:invoices:'));
    expect(names.sort()).toEqual([
      'mica:server:invoices:decline',
      'mica:server:invoices:getOpen',
      'mica:server:invoices:pay'
    ]);
  });

  it('lists only the caller’s open, unexpired invoices', async () => {
    dbMock.query.mockResolvedValueOnce([OPEN]);
    const reply = await fire('getOpen', {});
    expect(reply).toEqual([OPEN]);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      "`citizenid` = ? AND `status` = 'active' AND `expires_at` > ?"
    );
    expect(params).toEqual(['CID_PAYER', NOW]);
  });
});

describe('pay', () => {
  it('claims the row before any money moves, then pays the society', async () => {
    const reply = await fire('pay', { id: 7 });

    expect(reply).toMatchObject({ ok: true });
    const [claimSql, claimParams] = updates()[0];
    expect(claimSql).toContain("WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'");
    expect(claimParams).toEqual(['paid', null, 7, 'CID_PAYER']);
    // The claim landed before Payments was asked — that ordering is the double-pay defence.
    expect(dbMock.update.mock.invocationCallOrder[0]).toBeLessThan(
      payments.payToSociety.mock.invocationCallOrder[0]
    );
    expect(payments.payToSociety).toHaveBeenCalledWith({
      from: 'CID_PAYER',
      job: 'mechanic',
      amount: 450,
      reason: 'Invoice 7 from Los Santos Customs'
    });
    // And the timestamp is stamped only once the money landed.
    expect(updates()[1][0]).toContain('SET `paid_at` = ?');
    expect(updates()[1][1]).toEqual([NOW, 7, 'CID_PAYER']);
  });

  it('pays a character through transfer when the invoice names a payee', async () => {
    dbMock.single.mockResolvedValue({ ...OPEN, society: null, payee: 'CID_BILLER' });
    await fire('pay', { id: 7 });
    expect(payments.transfer).toHaveBeenCalledWith({
      from: 'CID_PAYER',
      to: 'CID_BILLER',
      amount: 450,
      account: 'bank',
      reason: 'Invoice 7 from Los Santos Customs'
    });
    expect(payments.payToSociety).not.toHaveBeenCalled();
  });

  it('reopens the row and passes the reason through when the payment is refused', async () => {
    payments.payToSociety.mockResolvedValueOnce({ ok: false, reason: 'insufficient_funds' });

    const reply = await fire('pay', { id: 7 });

    expect(reply).toEqual({ ok: false, reason: 'insufficient_funds' });
    const [reopenSql, reopenParams] = updates()[1];
    expect(reopenSql).toContain("SET `status` = 'active', `paid_at` = NULL");
    expect(reopenSql).toContain("`status` = 'paid' AND `paid_at` IS NULL");
    expect(reopenParams).toEqual([7, 'CID_PAYER']);
  });

  it('cannot be paid twice: a claim that finds no open row is not_open and moves no money', async () => {
    // The second tap: the row reads `active` (stale), but the atomic claim finds nothing.
    dbMock.update.mockResolvedValueOnce(false);

    const reply = await fire('pay', { id: 7 });

    expect(reply).toEqual({ ok: false, reason: 'not_open' });
    expect(payments.payToSociety).not.toHaveBeenCalled();
    expect(payments.transfer).not.toHaveBeenCalled();
  });

  it('refuses a row already settled without asking the database to claim it', async () => {
    dbMock.single.mockResolvedValue({ ...OPEN, status: 'paid' });
    expect(await fire('pay', { id: 7 })).toEqual({ ok: false, reason: 'not_open' });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('answers unknown_invoice for a row that is not the caller’s, the same as for none', async () => {
    // `findById` is owner-scoped: somebody else's id answers null, exactly like a bad id.
    dbMock.single.mockResolvedValue(null);
    expect(await fire('pay', { id: 99 })).toEqual({ ok: false, reason: 'unknown_invoice' });
    const [sql, params] = dbMock.single.mock.calls[0];
    expect(String(sql)).toContain('citizenid');
    expect(params).toEqual(expect.arrayContaining([99, 'CID_PAYER']));
    expect(payments.payToSociety).not.toHaveBeenCalled();
  });

  it('refuses a lapsed invoice as expired and sweeps it, moving no money', async () => {
    dbMock.single.mockResolvedValue({ ...OPEN, expires_at: NOW - 1 });

    const reply = await fire('pay', { id: 7 });

    expect(reply).toEqual({ ok: false, reason: 'expired' });
    expect(updates()[0][0]).toContain(
      "SET `status` = 'expired' WHERE `status` = 'active' AND `expires_at` <= ?"
    );
    expect(payments.payToSociety).not.toHaveBeenCalled();
  });

  it('refuses a malformed id through the contract before touching anything', async () => {
    const reply = await fire('pay', { id: 'seven' });
    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

describe('decline', () => {
  it('moves the row to declined through the same atomic claim and tells the biller', async () => {
    const onDeclined = vi.fn();
    await createInvoice(
      {
        citizenid: 'CID_PAYER',
        from_label: 'Los Santos Customs',
        amount: 450,
        memo: null,
        society: 'mechanic',
        payee: null,
        resource: 'lsc-garage'
      },
      { onDeclined }
    );

    const reply = await fire('decline', { id: 7 });

    expect(reply).toMatchObject({ ok: true });
    const [sql, params] = updates()[0];
    expect(sql).toContain("`status` = 'active'");
    expect(params).toEqual(['declined', null, 7, 'CID_PAYER']);
    expect(onDeclined).toHaveBeenCalledWith(expect.objectContaining({ id: 7, status: 'declined' }));
    expect(payments.payToSociety).not.toHaveBeenCalled();
  });

  it('is not_open when a pay got there first', async () => {
    dbMock.update.mockResolvedValueOnce(false);
    expect(await fire('decline', { id: 7 })).toEqual({ ok: false, reason: 'not_open' });
  });
});

describe('a biller’s callback', () => {
  it('is told about a payment, once, and its failure never reaches the player', async () => {
    const onPaid = vi.fn(() => {
      throw new Error('biller bug');
    });
    await createInvoice(
      {
        citizenid: 'CID_PAYER',
        from_label: 'LSC',
        amount: 450,
        memo: null,
        society: 'mechanic',
        payee: null,
        resource: 'lsc-garage'
      },
      { onPaid }
    );

    const reply = await fire('pay', { id: 7 });

    expect(reply).toMatchObject({ ok: true });
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: 'paid', paid_at: NOW })
    );
  });

  it('is dropped when its resource stops, so a dead ref is never called', async () => {
    const onPaid = vi.fn();
    await createInvoice(
      {
        citizenid: 'CID_PAYER',
        from_label: 'LSC',
        amount: 450,
        memo: null,
        society: 'mechanic',
        payee: null,
        resource: 'lsc-garage'
      },
      { onPaid }
    );
    for (const handler of localHandlers.get('onResourceStop') ?? []) handler('lsc-garage');

    await fire('pay', { id: 7 });

    expect(onPaid).not.toHaveBeenCalled();
  });
});

describe('creation, through SendInvoice', () => {
  beforeEach(() => registerPublicApi());

  const send = (cid: unknown, opts: unknown) =>
    (publishedExport('SendInvoice') as Function)(cid, opts);

  it('writes an open row with the expiry from the convar and pushes a notification the shade keeps', async () => {
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_invoice_expiry_days' ? 3 : fallback;

    const result = await send('CID_OFFLINE', {
      from: 'Los Santos Customs',
      amount: 450,
      memo: 'Engine work',
      society: 'mechanic'
    });

    expect(result).toEqual({ ok: true, value: { id: 7 } });
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toContain('mica_invoices');
    expect(params).toEqual(
      expect.arrayContaining([
        'CID_OFFLINE',
        'Los Santos Customs',
        450,
        'Engine work',
        'mechanic',
        'test-resource',
        NOW + 3 * 86_400
      ])
    );
    // The player is offline: nothing is emitted, and the notification row is what survives.
    expect((globalThis.emitNet as any).mock.calls).toEqual([]);
  });

  it('is delivered live when the player is online', async () => {
    await send('CID_PAYER', { from: 'LSC', amount: 10, society: 'mechanic' });
    const pushes = (globalThis.emitNet as any).mock.calls.filter(
      ([event]: [string]) => event === 'mica:client:shell:appEvent'
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toBe(1);
    expect(pushes[0][2]).toMatchObject({ app: 'bank', event: 'invoice', payload: { id: 7 } });
  });

  it.each([
    ['no from', { amount: 10, society: 'mechanic' }],
    ['a from past 64 characters', { from: 'x'.repeat(65), amount: 10, society: 'mechanic' }],
    ['a fractional amount', { from: 'LSC', amount: 10.5, society: 'mechanic' }],
    ['a zero amount', { from: 'LSC', amount: 0, society: 'mechanic' }],
    [
      'both a society and a payee',
      { from: 'LSC', amount: 10, society: 'mechanic', payee: 'CID_X' }
    ],
    ['neither a society nor a payee', { from: 'LSC', amount: 10 }],
    ['a society that is not a job key', { from: 'LSC', amount: 10, society: 'Mechanic Shop' }],
    [
      'a memo past 140 characters',
      { from: 'LSC', amount: 10, society: 'mechanic', memo: 'x'.repeat(141) }
    ],
    ['a non-function onPaid', { from: 'LSC', amount: 10, society: 'mechanic', onPaid: 'yes' }]
  ])('refuses %s with invalid_args and writes nothing', async (_label, opts) => {
    const result = await send('CID_PAYER', opts);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a citizenid the framework has no record of', async () => {
    directory.resolve.mockResolvedValueOnce(null as never);
    const result = await send('CID_NOBODY', { from: 'LSC', amount: 10, society: 'mechanic' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('expiry', () => {
  it('defaults to seven days and takes the convar when set', () => {
    expect(expiryDays()).toBe(7);
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_invoice_expiry_days' ? 14 : fallback;
    expect(expiryDays()).toBe(14);
    (globalThis as any).GetConvarInt = () => -3;
    expect(expiryDays()).toBe(7);
  });

  it('sweeps every open row past its date in one statement, and survives a failing one', async () => {
    await expireDueInvoices();
    const [sql, params] = updates()[0];
    expect(sql).toBe(
      "UPDATE `mica_invoices` SET `status` = 'expired' WHERE `status` = 'active' AND `expires_at` <= ?"
    );
    expect(params).toEqual([NOW]);

    dbMock.update.mockRejectedValueOnce(new Error('gone'));
    await expect(expireDueInvoices()).resolves.toBeUndefined();
  });

  it('runs once at resource start', async () => {
    for (const handler of localHandlers.get('onResourceStart') ?? []) handler('mica');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates().some(([sql]) => sql.includes("SET `status` = 'expired'"))).toBe(true);
  });
});
