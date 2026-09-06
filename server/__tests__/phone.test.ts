// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, handlers, globalHandlers, commands } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const capturedGlobal = new Map<string, Function>();
  const capturedCommands = new Map<string, Function>();
  const previousOnNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    capturedGlobal.set(event, handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  (globalThis as any).RegisterCommand = (name: string, handler: Function) => {
    capturedCommands.set(name, handler);
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    globalHandlers: capturedGlobal,
    commands: capturedCommands
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const adminState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../services/Admin', () => ({
  isAdmin: (src: number) => (src === 0 ? true : adminState.isAdmin)
}));

const bridge = vi.hoisted(() => ({
  players: new Map<number, string>([
    [1, 'CID_CALLER'],
    [2, 'CID_TARGET'],
    [3, 'CID_THIRD']
  ]),
  phones: new Map<number, string>([
    [1, '555-0001'],
    [2, '555-0002'],
    [3, '555-0003']
  ])
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      bridge.players.has(src) ? { citizenid: bridge.players.get(src), source: src } : null,
    getCitizenId: (src: number) => bridge.players.get(src) ?? null,
    getPlayerPhone: (src: number) => bridge.phones.get(src) ?? null,
    getPlayerByPhone: (phone: string) => {
      for (const [src, p] of bridge.phones) {
        if (p === phone) return { source: src, citizenid: bridge.players.get(src) };
      }
      return null;
    }
  }
}));

import '../services/Phone';
import { __resetCalls, injectIncomingCall, endActiveCallFor, placeCall } from '../services/Phone';
import { __resetRateLimits, allow } from '../lib/rateLimit';
import { registerNumber, releaseResource } from '../lib/numberRegistry';

const START = 'mica:server:phone:start';
const ANSWER = 'mica:server:phone:answer';
const END = 'mica:server:phone:end';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetCalls();
  adminState.isAdmin = true;
  dbMock.insert.mockResolvedValue(1);
  dbMock.query.mockResolvedValue([]);
  // `Blocklist.ts`'s `isBlocked` (MICA-64), asked once per call: `null` means nobody is
  // blocked, so every pre-existing test in this file connects exactly as it always did.
  dbMock.scalar.mockResolvedValue(null);
  (globalThis as any).emitNet = vi.fn();
});

const runCommand = async (name: string, src: number, args: string[] = []) => {
  (globalThis as any).source = src;
  const handler = commands.get(name);
  if (!handler) throw new Error(`no command registered for ${name}`);
  handler(src, args);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const fire = async (event: string, src: number, ...args: unknown[]) => {
  (globalThis as any).source = src;
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  handler(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createCalls = () =>
  (dbMock.insert as any).mock.calls.map((args: unknown[]) => args as [string, unknown[]]);

const emitCalls = () => (globalThis as any).emitNet.mock.calls as [string, number, ...unknown[]][];

const drop = async (src: number) => {
  (globalThis as any).source = src;
  const handler = globalHandlers.get('playerDropped');
  if (!handler) throw new Error('no handler for playerDropped');
  handler();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('Phone call log writes', () => {
  it('logs outgoing (answered) and incoming on a normal answered-then-ended call', async () => {
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    await fire(END, 2);

    const inserts = createCalls();
    expect(inserts).toHaveLength(2);

    const [callerSql, callerParams] = inserts[0];
    expect(callerSql).toMatch(/mica_phone_call_log/);
    expect(callerParams).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', '555-0002']));

    const [, targetParams] = inserts[1];
    expect(targetParams).toEqual(expect.arrayContaining(['CID_TARGET', 'incoming', '555-0001']));
  });

  it('logs outgoing + missed when the target never answers', async () => {
    await fire(START, 1, '555-0002');
    await fire(END, 1); // caller hangs up before pickup

    const inserts = createCalls();
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', 0]));
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));
  });

  it('logs outgoing + missed when the target declines (same event as end)', async () => {
    await fire(START, 1, '555-0002');
    await fire(END, 2); // target declines — client sends the same `end` event

    const inserts = createCalls();
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));
  });

  it('logs a dropped connection mid-call the same as a normal end', async () => {
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    await drop(1);

    const inserts = createCalls();
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual(
      expect.arrayContaining(['CID_CALLER', 'outgoing', expect.any(Number)])
    );
    expect(inserts[1][1]).toEqual(
      expect.arrayContaining(['CID_TARGET', 'incoming', expect.any(Number)])
    );
  });
});

describe('playerDropped teardown', () => {
  it('notifies the survivor and cleans up both sides when the caller drops before answer', async () => {
    await fire(START, 1, '555-0002');
    await drop(1);

    const ended = emitCalls().filter(([event]) => event === 'mica:client:phone:ended');
    expect(ended).toEqual([['mica:client:phone:ended', 2]]);

    const inserts = createCalls();
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', 0]));
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));

    // Both maps are fully cleared — the survivor can immediately place a new call.
    (globalThis as any).emitNet.mockClear();
    await fire(START, 2, '555-0003');
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
  });

  it('notifies the caller and logs missed when the target drops before answering', async () => {
    await fire(START, 1, '555-0002');
    await drop(2);

    const ended = emitCalls().filter(([event]) => event === 'mica:client:phone:ended');
    expect(ended).toEqual([['mica:client:phone:ended', 1]]);

    const inserts = createCalls();
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));
  });

  it('does nothing for a source with no active call', async () => {
    await drop(3);

    expect(emitCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
  });
});

// `notifyPlayer` fires its own `mica:client:shell:notify` before the handler's own
// `phone:failed`, so every refusal below is asserted by filtering for the one event that
// tells the client to reset, not by the full call list.
const failedTo = (src: number) =>
  emitCalls().filter(([event, dest]) => event === 'mica:client:phone:failed' && dest === src);

describe('start: refusals', () => {
  it('refuses a self-call as Busy and tells the client to reset', async () => {
    await fire(START, 1, '555-0001');

    expect(failedTo(1)).toHaveLength(1);
    expect(createCalls()).toHaveLength(0);
  });

  it('refuses an unknown number as unavailable and tells the client to reset', async () => {
    await fire(START, 1, '555-9999');

    expect(failedTo(1)).toHaveLength(1);
  });

  it('still logs an unreachable number as an outgoing call of zero duration', async () => {
    await fire(START, 1, '555-9999');

    // MICA-95: nothing else writes this row — no `ActiveCall` is created on this path,
    // so `logCallEnd` never runs for it and Recents used to be unchanged after dialling
    // a number nobody was on.
    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    const [sql, params] = inserts[0];
    expect(sql).toMatch(/mica_phone_call_log/);
    expect(params).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', '555-9999', 0]));
  });

  it('logs nothing for a self-call or a busy line — neither call was ever placed', async () => {
    await fire(START, 1, '555-0001');
    expect(createCalls()).toHaveLength(0);

    await fire(START, 1, '555-0002'); // caller now on a call
    (dbMock.insert as any).mockClear();
    await fire(START, 1, '555-0003');
    expect(createCalls()).toHaveLength(0);
  });

  it('refuses when the caller is already on a call', async () => {
    await fire(START, 1, '555-0002');
    (globalThis as any).emitNet.mockClear();

    await fire(START, 1, '555-0003');

    expect(failedTo(1)).toHaveLength(1);
    // The original call is untouched — no second insert, no incoming to 3.
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(0);
  });

  it('refuses when the target is already on a call', async () => {
    await fire(START, 1, '555-0002');
    (globalThis as any).emitNet.mockClear();

    await fire(START, 3, '555-0002');

    expect(failedTo(3)).toHaveLength(1);
  });

  it('silently drops a malformed number before ever reaching the framework', async () => {
    await fire(START, 1, { not: 'a string' });

    // Distinct from the unknown-number case above: no failed event either, because
    // `phoneNumberFrom` rejects it before the handler tries to resolve anything.
    expect(emitCalls()).toHaveLength(0);
  });
});

/**
 * MICA-64. A blocked call must fail in a way that does not confirm the block — the
 * ticket's own reading — so every assertion here is phrased against "does this look
 * exactly like an unreachable number", not just "does it fail".
 */
describe('start: blocking (MICA-64)', () => {
  it('refuses a call the target has blocked, indistinguishably from an unreachable number', async () => {
    dbMock.scalar.mockResolvedValue(1); // CID_TARGET has blocked 555-0001

    await fire(START, 1, '555-0002');

    expect(failedTo(1)).toHaveLength(1);
    // No `incoming` ever reached the target — the call never rang at all.
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(0);
  });

  it('logs the same call-log row a genuinely unreachable number would', async () => {
    // Same shape as `still logs an unreachable number as an outgoing call of zero
    // duration` above — a caller comparing their own Recents must not be able to tell a
    // block from a wrong number.
    dbMock.scalar.mockResolvedValue(1);

    await fire(START, 1, '555-0002');

    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    const [sql, params] = inserts[0];
    expect(sql).toMatch(/mica_phone_call_log/);
    expect(params).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', '555-0002', 0]));
  });

  it('asks the blocklist about the target being called, keyed on the caller own number', async () => {
    dbMock.scalar.mockResolvedValue(null);

    await fire(START, 1, '555-0002');

    expect(dbMock.scalar).toHaveBeenCalledWith(expect.any(String), ['CID_TARGET', '555-0001']);
  });

  it('connects normally when nobody has blocked the caller', async () => {
    dbMock.scalar.mockResolvedValue(null);

    await fire(START, 1, '555-0002');

    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
  });
});

describe('start: the emergency number always connects (MICA-64)', () => {
  const EMERGENCY_SRC = 9;

  beforeEach(() => {
    bridge.players.set(EMERGENCY_SRC, 'CID_DISPATCH');
    bridge.phones.set(EMERGENCY_SRC, '911');
  });

  afterEach(() => {
    bridge.players.delete(EMERGENCY_SRC);
    bridge.phones.delete(EMERGENCY_SRC);
  });

  it('connects even though the target has blocked the caller', async () => {
    dbMock.scalar.mockResolvedValue(1); // would refuse any other number

    await fire(START, 1, '911');

    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
    expect(failedTo(1)).toHaveLength(0);
  });

  it('never asks the blocklist at all for the emergency number', async () => {
    dbMock.scalar.mockResolvedValue(1);

    await fire(START, 1, '911');

    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('honours an operator-configured emergency number rather than only 911', async () => {
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_emergency_number' ? '112' : fallback;
    bridge.phones.set(EMERGENCY_SRC, '112');
    dbMock.scalar.mockResolvedValue(1);

    await fire(START, 1, '112');

    (globalThis as any).GetConvar = previous;
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
  });

  it('still checks the blocklist for 911 once the convar points somewhere else', async () => {
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_emergency_number' ? '112' : fallback;
    dbMock.scalar.mockResolvedValue(1); // blocked

    await fire(START, 1, '911');

    (globalThis as any).GetConvar = previous;
    // 911 is an ordinary number again once it is not the configured emergency line, so
    // the block that was ignored above now applies.
    expect(failedTo(1)).toHaveLength(1);
  });
});

describe('answer / end guards', () => {
  it('answering with no active call does nothing', async () => {
    await fire(ANSWER, 3);

    expect(emitCalls()).toHaveLength(0);
  });

  it('a source that is not the call target answering does nothing', async () => {
    await fire(START, 1, '555-0002');
    (globalThis as any).emitNet.mockClear();

    // The caller "answers" their own outgoing call — not the target.
    await fire(ANSWER, 1);

    expect(emitCalls()).toHaveLength(0);
  });

  it('ending with no active call does nothing', async () => {
    await fire(END, 3);

    expect(emitCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
  });
});

describe('rate limiting and payload guards on the raw onNet handlers', () => {
  it('start does nothing once the caller has exhausted the window', async () => {
    for (let i = 0; i < 61; i++) allow(1, 'phone', 'start');

    await fire(START, 1, '555-0002');

    expect(emitCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
  });

  it('answer does nothing once the caller has exhausted the window', async () => {
    await fire(START, 1, '555-0002');
    for (let i = 0; i < 61; i++) allow(2, 'phone', 'answer');
    (globalThis as any).emitNet.mockClear();

    await fire(ANSWER, 2);

    expect(emitCalls()).toHaveLength(0);
  });

  it('end does nothing once the caller has exhausted the window', async () => {
    await fire(START, 1, '555-0002');
    for (let i = 0; i < 61; i++) allow(1, 'phone', 'end');
    (globalThis as any).emitNet.mockClear();

    await fire(END, 1);

    expect(emitCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
  });
});

describe('injectIncomingCall / endActiveCallFor — micacall support', () => {
  it('rings the target with the given caller phone', async () => {
    const callId = injectIncomingCall(2, '555-9999');

    expect(callId).not.toBeNull();
    expect(emitCalls()).toEqual([['mica:client:phone:incoming', 2, { from: '555-9999', callId }]]);
  });

  it('refuses to inject onto a target already on a call', async () => {
    await fire(START, 1, '555-0002'); // 2 is now busy
    (globalThis as any).emitNet.mockClear();

    const callId = injectIncomingCall(2, '555-9999');

    expect(callId).toBeNull();
    expect(emitCalls()).toHaveLength(0);
  });

  it('the target can answer an injected call through the real answer handler', async () => {
    const callId = injectIncomingCall(2, '555-9999');
    (globalThis as any).emitNet.mockClear();

    await fire(ANSWER, 2);

    // The fake caller (-1) hears 'accepted' too, same as the real handler always does —
    // harmless, since nothing real is ever connected at that source.
    expect(emitCalls()).toEqual(
      expect.arrayContaining([['mica:client:phone:accepted', 2, { callId }]])
    );
  });

  it('notifies only the real party and logs on their side alone', async () => {
    injectIncomingCall(2, '555-9999');
    (globalThis as any).emitNet.mockClear();

    const ended = endActiveCallFor(2);

    expect(ended).toBe(true);
    expect(emitCalls()).toEqual([['mica:client:phone:ended', 2]]);

    // No caller-side row — there is no real citizenid behind the synthetic source.
    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));
  });

  it('is a no-op for a target with no active call', () => {
    expect(endActiveCallFor(3)).toBe(false);
  });
});

// `respondCall` notifies the caller of the outcome via `shell:notify`, same as
// `notifyPlayer` elsewhere in this file — every assertion below filters for the one
// event that matters rather than the full emit list.
const incomingCalls = () => emitCalls().filter(([event]) => event === 'mica:client:phone:incoming');
const endedCalls = () => emitCalls().filter(([event]) => event === 'mica:client:phone:ended');

describe('micacall command', () => {
  it('refuses a non-admin', async () => {
    adminState.isAdmin = false;

    await runCommand('micacall', 1);

    expect(incomingCalls()).toHaveLength(0);
  });

  it('refuses the console — there is no player source to ring', async () => {
    await runCommand('micacall', 0);

    expect(emitCalls()).toHaveLength(0);
  });

  it('rings the caller with a default number when no argument is given', async () => {
    await runCommand('micacall', 1);

    const incoming = emitCalls().find(([event]) => event === 'mica:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5550100' }));
  });

  it('rings from a seeded character by first name', async () => {
    await runCommand('micacall', 1, ['Marla']);

    const incoming = emitCalls().find(([event]) => event === 'mica:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5550101' }));
  });

  it('rings from an arbitrary literal number', async () => {
    await runCommand('micacall', 1, ['5559999']);

    const incoming = emitCalls().find(([event]) => event === 'mica:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5559999' }));
  });

  it('refuses to ring someone already on a call', async () => {
    await runCommand('micacall', 1);
    (globalThis as any).emitNet.mockClear();

    await runCommand('micacall', 1);

    expect(incomingCalls()).toHaveLength(0);
  });

  it("end tears down the caller's own active call", async () => {
    await runCommand('micacall', 1);
    (globalThis as any).emitNet.mockClear();

    await runCommand('micacall', 1, ['end']);

    expect(endedCalls()).toEqual([['mica:client:phone:ended', 1]]);
  });

  it('end on a caller with no active call does not throw or emit', async () => {
    await runCommand('micacall', 1, ['end']);

    expect(endedCalls()).toHaveLength(0);
  });
});

/**
 * MICA-226. A number no character holds now falls back to `numberRegistry` before it is
 * declared unreachable. The registry itself is exercised in `numberRegistry.test.ts`; what
 * is under test here is only the wiring — which of the two lookups wins, whether the
 * blocklist is still consulted, and that a line call tears down like any other.
 */
describe('start: registered lines (MICA-226)', () => {
  const LINE = '5559999';
  const LINE_HOLDER_SRC = 4;

  afterEach(() => {
    releaseResource('taxi');
    bridge.players.delete(LINE_HOLDER_SRC);
    bridge.phones.delete(LINE_HOLDER_SRC);
  });

  it('rings the line handler when no character holds the number', async () => {
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall }, 'taxi');

    await fire(START, 1, LINE);

    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ from: '555-0001', source: 1 }));
    expect(emitCalls()).toEqual(
      expect.arrayContaining([['mica:client:phone:accepted', 1, { callId: expect.any(Number) }]])
    );
  });

  it('lets a character who holds the number win over the line that registered it', async () => {
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall }, 'taxi');
    // The framework can hand this number to a character after registration, so the
    // per-call ordering rather than the registration check is what has to hold.
    bridge.players.set(LINE_HOLDER_SRC, 'CID_LINE');
    bridge.phones.set(LINE_HOLDER_SRC, LINE);

    await fire(START, 1, LINE);

    expect(onCall).not.toHaveBeenCalled();
    expect(emitCalls()).toEqual(
      expect.arrayContaining([
        [
          'mica:client:phone:incoming',
          LINE_HOLDER_SRC,
          { from: '555-0001', callId: expect.any(Number) }
        ]
      ])
    );
  });

  it('gives two callers of one line a call each rather than refusing the second', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');

    await placeCall(1, LINE);
    await placeCall(3, LINE);

    const accepted = emitCalls().filter(([event]) => event === 'mica:client:phone:accepted');
    expect(accepted.map(([, dest]) => dest)).toEqual([1, 3]);
    const ids = accepted.map(([, , payload]) => (payload as { callId: number }).callId);
    expect(new Set(ids).size).toBe(2);
    expect(failedTo(3)).toHaveLength(0);
  });

  it('fails a rejecting line exactly like an unreachable number', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'reject' }) as const }, 'taxi');

    await fire(START, 1, LINE);

    // Same three things `still logs an unreachable number` asserts: the reset event, one
    // zero-duration outgoing row, and nothing else.
    expect(failedTo(1)).toHaveLength(1);
    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE, 0]));
  });

  it('forwards to the real player path when the handler names a source', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'forward', source: 2 }) as const }, 'taxi');

    await fire(START, 1, LINE);

    // Re-dialled by 2's own number, so this is an ordinary player-to-player call from here
    // on — the target's client rings, rather than the caller being told the call connected.
    expect(emitCalls()).toEqual(
      expect.arrayContaining([
        ['mica:client:phone:incoming', 2, { from: '555-0001', callId: expect.any(Number) }]
      ])
    );
  });

  it('fails a forward to a source nobody is connected on', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'forward', source: 99 }) as const }, 'taxi');

    await fire(START, 1, LINE);

    expect(failedTo(1)).toHaveLength(1);
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toHaveLength(0);
  });

  it('asks the blocklist about a blockable line, and refuses when it answers yes', async () => {
    dbMock.scalar.mockResolvedValue(1);
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall }, 'taxi');

    await fire(START, 1, LINE);

    expect(dbMock.scalar).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
    expect(failedTo(1)).toHaveLength(1);
  });

  it('never asks the blocklist at all for an unblockable line', async () => {
    dbMock.scalar.mockResolvedValue(1); // would refuse any blockable number
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall, blockable: false }, 'taxi');

    await fire(START, 1, LINE);

    expect(dbMock.scalar).not.toHaveBeenCalled();
    expect(onCall).toHaveBeenCalled();
    expect(failedTo(1)).toHaveLength(0);
  });

  it('ends a live call on a line whose owning resource goes away', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    await fire(START, 1, LINE);
    (globalThis as any).emitNet.mockClear();

    releaseResource('taxi');

    // Without this the caller's phone stays on a call whose far end is a dead function ref.
    expect(endedCalls()).toEqual(expect.arrayContaining([['mica:client:phone:ended', 1]]));
  });
});
