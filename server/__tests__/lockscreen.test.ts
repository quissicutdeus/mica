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

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} })
  }
}));

import '../services/Lockscreen';
import { __resetRateLimits } from '../lib/rateLimit';
import { __resetLockscreenAttempts, __setLockscreenClock } from '../services/Lockscreen';

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:lockscreen:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

/** Every parameter array `Database.query` (the upsert/clear path) was called with. */
const queryCalls = () => dbMock.query.mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetLockscreenAttempts();
  __setLockscreenClock();
  dbMock.single.mockResolvedValue(null);
  dbMock.query.mockResolvedValue(undefined);
});

describe('lockscreen:status (MICA-60)', () => {
  it('reports no passcode when no row exists', async () => {
    dbMock.single.mockResolvedValue(null);
    const reply = await call('status', {});
    expect(reply).toEqual({ hasPasscode: false });
  });

  it('reports a passcode is set without naming anything about it', async () => {
    dbMock.single.mockResolvedValue({
      id: 1,
      citizenid: 'CIT_A',
      passcode_hash: 'deadbeef',
      passcode_salt: 'salt'
    });
    const reply = await call('status', {});
    expect(reply).toEqual({ hasPasscode: true });
  });

  it('reads only the caller citizenid, never one from the payload', async () => {
    await call('status', { citizenid: 'CIT_VICTIM' });
    expect(dbMock.single.mock.calls[0][1]).toEqual(['CIT_A']);
  });
});

describe('lockscreen:set (MICA-60)', () => {
  it('refuses a passcode that is not all digits', async () => {
    const reply = await call('set', { passcode: '12ab' });
    expect(reply).toMatchObject({ error: expect.stringMatching(/4 to 6 digits/) });
    expect(queryCalls()).toHaveLength(0);
  });

  it.each(['123', '1234567', '', ' '])('refuses a %s-length passcode', async (bad) => {
    const reply = await call('set', { passcode: bad });
    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(queryCalls()).toHaveLength(0);
  });

  it.each(['1234', '123456'])('accepts a valid %s-digit passcode', async (good) => {
    const reply = await call('set', { passcode: good });
    expect(reply).toEqual({ ok: true });
    expect(queryCalls()).toHaveLength(1);
  });

  it('never writes the raw passcode to SQL — only a hash and a salt', async () => {
    await call('set', { passcode: '135790' });

    const [sql, params] = queryCalls()[0];
    expect(String(sql)).toContain('INSERT INTO gphone_lockscreen');
    // citizenid, hash, salt — none of them the literal passcode.
    expect(params).not.toContain('135790');
    const [, hash, salt] = params as string[];
    expect(hash).not.toBe('135790');
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    expect(salt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
  });

  it('salts each write independently, so two players with the same PIN store different hashes', async () => {
    await call('set', { passcode: '111111' }, 'CIT_A');
    await call('set', { passcode: '111111' }, 'CIT_B');

    const [, hashA, saltA] = queryCalls()[0][1] as string[];
    const [, hashB, saltB] = queryCalls()[1][1] as string[];
    expect(saltA).not.toBe(saltB);
    expect(hashA).not.toBe(hashB);
  });

  it('writes under the caller citizenid, never one from the payload', async () => {
    await call('set', { passcode: '123456', citizenid: 'CIT_VICTIM' });
    expect(queryCalls()[0][1][0]).toBe('CIT_A');
  });
});

describe('lockscreen:check (MICA-60)', () => {
  /** Round-trips a `set` through the mocked upsert so `check` can be handed the same row back. */
  const setAndCapture = async (passcode: string) => {
    await call('set', { passcode });
    const [, passcode_hash, passcode_salt] = queryCalls()[0][1] as string[];
    dbMock.single.mockResolvedValue({
      id: 1,
      citizenid: 'CIT_A',
      passcode_hash,
      passcode_salt
    });
  };

  it('answers false when no passcode is set', async () => {
    dbMock.single.mockResolvedValue(null);
    const reply = await call('check', { passcode: '1234' });
    expect(reply).toEqual({ ok: false });
  });

  it('answers true for the correct passcode', async () => {
    await setAndCapture('482091');
    const reply = await call('check', { passcode: '482091' });
    expect(reply).toEqual({ ok: true });
  });

  it('answers false for an incorrect passcode, never anything more specific', async () => {
    await setAndCapture('482091');
    const reply = await call('check', { passcode: '482092' });
    expect(reply).toEqual({ ok: false });
    expect(Object.keys(reply)).toEqual(['ok']);
  });

  it('answers false for a non-string guess rather than throwing', async () => {
    await setAndCapture('482091');
    const reply = await call('check', { passcode: 482091 });
    expect(reply).toEqual({ ok: false });
  });

  it('checks only the caller citizenid, never one from the payload', async () => {
    await setAndCapture('482091');
    await call('check', { passcode: '482091', citizenid: 'CIT_VICTIM' });
    // The lookup is keyed on the resolved caller, not the payload's claim.
    expect(dbMock.single.mock.calls.at(-1)?.[1]).toEqual(['CIT_A']);
  });
});

describe('lockscreen:clear (MICA-60)', () => {
  it("deletes the caller's own row", async () => {
    const reply = await call('clear', {});
    expect(reply).toEqual({ ok: true });
    const [sql, params] = queryCalls()[0];
    expect(String(sql)).toContain('DELETE FROM gphone_lockscreen');
    expect(params).toEqual(['CIT_A']);
  });

  it('is idempotent — clearing an already-unset passcode still answers ok', async () => {
    dbMock.query.mockResolvedValue(undefined);
    const reply = await call('clear', {});
    expect(reply).toEqual({ ok: true });
  });

  it('clears only the caller citizenid, never one from the payload', async () => {
    await call('clear', { citizenid: 'CIT_VICTIM' });
    expect(queryCalls()[0][1]).toEqual(['CIT_A']);
  });
});

describe('lockscreen — no generic action survives', () => {
  it('registers exactly the four named actions and nothing generic', () => {
    expect(
      [...handlers.keys()].filter((e) => e.startsWith('gphone:server:lockscreen:')).toSorted()
    ).toEqual([
      'gphone:server:lockscreen:check',
      'gphone:server:lockscreen:clear',
      'gphone:server:lockscreen:set',
      'gphone:server:lockscreen:status'
    ]);
  });
});

/**
 * MICA-164. The PIN was stored as one salted SHA-256 pass, which CodeQL flags as
 * `js/insufficient-password-hash` and is right to: a salt defeats a table built for every
 * player at once and does nothing for the attacker holding one row, who can try all 10,000
 * four-digit candidates in milliseconds. A small keyspace is the argument *for* a memory-hard
 * KDF, not against it.
 *
 * scrypt rather than the Argon2id the ticket names: `dependencies` is empty, `node:crypto`
 * has no Argon2, and the server is bundled so a native binding is not an option. The
 * deviation is deliberate and recorded in `Lockscreen.ts`.
 */
describe('the passcode KDF (MICA-164)', () => {
  const storedHash = async (passcode: string): Promise<string> => {
    await call('set', { passcode });
    const row = queryCalls().at(-1)?.[1];
    return row[1];
  };

  it('does not store the passcode as a bare SHA-256 of salt and passcode', async () => {
    const hash = await storedHash('482091');
    const salt = queryCalls().at(-1)?.[1][2];

    // The exact shape the old implementation wrote. If this ever matches again, the KDF has
    // been reverted to something a laptop can exhaust over lunch.
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256').update(`${salt}:482091`).digest().toString('hex');
    expect(hash).not.toBe(legacy);
  });

  it('still stores a 64-character hex digest, which is what the column holds', async () => {
    expect(await storedHash('482091')).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The absent-row case has to cost what the present one costs.
   *
   * Returning early on a missing row answered in a millisecond while a real check paid the
   * full KDF — a timing oracle for whether a citizenid has a passcode. Asserted as a floor
   * rather than a comparison between the two paths: a slow machine makes this number bigger,
   * never smaller, so the only way to fail it is to stop doing the work.
   */
  it('pays the KDF cost even when no row exists, so absence is not timeable', async () => {
    dbMock.single.mockResolvedValue(null);

    const started = Date.now();
    expect(await call('check', { passcode: '482091' })).toEqual({ ok: false });

    expect(Date.now() - started).toBeGreaterThan(5);
  });

  it('verifies a passcode it hashed itself', async () => {
    await call('set', { passcode: '482091' });
    dbMock.single.mockResolvedValue({
      passcode_hash: queryCalls().at(-1)?.[1][1],
      passcode_salt: queryCalls().at(-1)?.[1][2]
    });

    expect(await call('check', { passcode: '482091' })).toEqual({ ok: true });
    expect(await call('check', { passcode: '482092' })).toEqual({ ok: false });
  });
});

describe('passcode attempt limiting (MICA-164)', () => {
  const wrong = () => call('check', { passcode: '000000' });

  beforeEach(async () => {
    await call('set', { passcode: '482091' });
    dbMock.single.mockResolvedValue({
      passcode_hash: queryCalls().at(-1)?.[1][1],
      passcode_salt: queryCalls().at(-1)?.[1][2]
    });
  });

  it('locks out after the configured number of wrong guesses', async () => {
    for (let i = 0; i < 5; i++) expect(await wrong()).toEqual({ ok: false });

    // The sixth is refused rather than answered, and says how long for: a lockout the player
    // cannot see is a lock screen that looks broken. It arrives as `{ error }` rather than a
    // rejection because that is how `ServiceEndpoint` delivers a message to a player.
    expect(await call('check', { passcode: '482091' })).toEqual({
      error: expect.stringMatching(/Too many attempts\. Try again in \d+s\./)
    });
  });

  it('lets the right passcode through again once the lockout expires', async () => {
    let clock = 1_000_000;
    __setLockscreenClock(() => clock);
    for (let i = 0; i < 5; i++) await wrong();
    expect(await wrong()).toEqual({ error: expect.stringContaining('Too many attempts') });

    clock += 60_001;
    expect(await call('check', { passcode: '482091' })).toEqual({ ok: true });
  });

  it('clears the streak on a correct passcode, so guessing is priced and using it is not', async () => {
    for (let i = 0; i < 4; i++) await wrong();
    expect(await call('check', { passcode: '482091' })).toEqual({ ok: true });

    // Four more would have tripped the lockout had the streak survived.
    for (let i = 0; i < 4; i++) expect(await wrong()).toEqual({ ok: false });
  });

  /**
   * The lockout is keyed by citizenid rather than source because FiveM recycles server ids —
   * the same reason `rateLimit.forgetSource` exists. A source-keyed one is a reconnect away
   * from being reset by the person it is meant to slow down.
   */
  it('does not lock out a different player because this one was guessing', async () => {
    for (let i = 0; i < 5; i++) await wrong();
    expect(await wrong()).toEqual({ error: expect.stringContaining('Too many attempts') });

    expect(await call('check', { passcode: '000000' }, 'CIT_B')).toEqual({ ok: false });
  });
});
