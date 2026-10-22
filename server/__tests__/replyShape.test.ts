// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { s } from '@mica/shared/schema';
import { responseType } from '@mica/shared/contract';
import { checkReply, resetReplyShapeForTests, withoutOwnerKeys } from '../lib/replyShape';

/**
 * A reply held to its contract (MICA-433). `bank:sendMoney` answered `transfer()`'s outcome
 * whole — the recipient's citizenid included — because nothing between a handler and the wire
 * looked at what it returned.
 */

const reply = s.union([
  s.object({ ok: s.literal(true) }, { unknownKeys: 'strip' }),
  s.object({ ok: s.literal(false), reason: s.string() }, { unknownKeys: 'strip' })
]);

describe('checkReply', () => {
  let env: string | undefined;
  beforeEach(() => {
    resetReplyShapeForTests();
    env = process.env.VITEST;
  });
  afterEach(() => {
    process.env.VITEST = env;
    (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
    vi.restoreAllMocks();
  });

  it('passes a reply the schema reads whole', async () => {
    expect(await checkReply('mica:server:bank:sendMoney', reply, { ok: true })).toEqual({
      ok: true
    });
    expect(
      await checkReply('mica:server:bank:sendMoney', reply, { ok: false, reason: 'x' })
    ).toEqual({ ok: false, reason: 'x' });
  });

  it('throws under test on an undeclared field, naming the field and never its value', async () => {
    const leaking = { ok: true, from: 'CID_CALLER', to: 'CID_TARGET', amount: 100 };
    const thrown = await checkReply('mica:server:bank:sendMoney', reply, leaking).catch(
      (error: Error) => error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('undeclared field(s): from, to, amount');
    expect((thrown as Error).message).not.toContain('CID_');
  });

  it('on a live server strips the undeclared fields and says so once', async () => {
    delete process.env.VITEST;
    (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaking = { ok: true, from: 'CID_CALLER', to: 'CID_TARGET' };

    expect(await checkReply('mica:server:bank:sendMoney', reply, leaking)).toEqual({ ok: true });
    expect(await checkReply('mica:server:bank:sendMoney', reply, leaking)).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('from, to');
    expect(String(warn.mock.calls[0][0])).not.toContain('CID_');
  });

  it('is strict on a test server (mica_integration), as under vitest', async () => {
    delete process.env.VITEST;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_integration' ? '1' : fallback;
    await expect(
      checkReply('mica:server:bank:sendMoney', reply, { ok: true, to: 'CID_TARGET' })
    ).rejects.toThrow('undeclared field(s): to');
  });

  it('passes a reply the schema refuses unchanged on a live server, and logs it', async () => {
    delete process.env.VITEST;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrong = { ok: 'yes' };
    expect(await checkReply('mica:server:bank:sendMoney', reply, wrong)).toBe(wrong);
    expect(String(warn.mock.calls[0][0])).toContain('does not match its declared shape');
  });

  it('leaves a responseType phantom and an undeclared output alone', async () => {
    const anything = { citizenid: 'CID', nested: { x: 1 } };
    expect(await checkReply('e', responseType<unknown>(), anything)).toBe(anything);
    expect(await checkReply('e', undefined, anything)).toBe(anything);
  });
});

describe('withoutOwnerKeys', () => {
  it('drops citizenid and device_id at every depth, in rows, pages and envelopes', () => {
    const at = new Date('2026-10-22T00:00:00Z');
    const sent = {
      ok: true,
      rows: [
        { id: 1, citizenid: 'CID', device_id: 'PHONE', title: 'a', created_at: at },
        { id: 2, nested: { citizenid: 'CID', keep: true } }
      ],
      nextCursor: null
    };
    expect(withoutOwnerKeys(sent)).toEqual({
      ok: true,
      rows: [
        { id: 1, title: 'a', created_at: at },
        { id: 2, nested: { keep: true } }
      ],
      nextCursor: null
    });
    // Copied, not mutated: a cached row keeps its owner.
    expect(sent.rows[0].citizenid).toBe('CID');
  });

  it('walks a row built in another realm, as oxmysql hands them across a resource', () => {
    const foreign = runInNewContext("({ id: 4, citizenid: 'CID', device_id: 'PHONE' })");
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(withoutOwnerKeys([foreign])).toEqual([{ id: 4 }]);
  });

  it('passes scalars, dates and binary through as they are', () => {
    const at = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    expect(withoutOwnerKeys('citizenid')).toBe('citizenid');
    expect(withoutOwnerKeys(at)).toBe(at);
    expect(withoutOwnerKeys(bytes)).toBe(bytes);
    expect(withoutOwnerKeys(null)).toBeNull();
  });
});
