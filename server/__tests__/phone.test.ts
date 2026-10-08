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
    // Speakerphone's bystander scan (MICA-246).
    getAllPlayers: () =>
      Object.fromEntries(
        [...bridge.players].map(([src, citizenid]) => [src, { PlayerData: { citizenid } }])
      ),
    getPlayerByPhone: (phone: string) => {
      for (const [src, p] of bridge.phones) {
        if (p === phone) return { source: src, citizenid: bridge.players.get(src) };
      }
      return null;
    }
  }
}));

import '../services/Phone';
import {
  __callById,
  __resetCalls,
  injectIncomingCall,
  endActiveCallFor,
  endLineCall,
  isInCall,
  placeCall
} from '../services/Phone';
import { __resetRateLimits, allow } from '../lib/rateLimit';
import { registerNumber, releaseResource, type CallVerdict } from '../lib/numberRegistry';
import { __setVoiceBackend } from '../lib/speakerphone';

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

const createCalls = (): [string, unknown[]][] =>
  dbMock.insert.mock.calls.map((args: unknown[]) => args as [string, unknown[]]);

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

    // The dropped source is told too (MICA-232): harmless to a gone client, and it keeps
    // teardown one rule — both real parties, always.
    const ended = emitCalls().filter(([event]) => event === 'mica:client:phone:ended');
    expect(ended).toEqual([
      ['mica:client:phone:ended', 1],
      ['mica:client:phone:ended', 2]
    ]);

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
    expect(ended).toEqual([
      ['mica:client:phone:ended', 1],
      ['mica:client:phone:ended', 2]
    ]);

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

    // Only the real party. `emitNet(event, -1)` is a broadcast in FiveM, so an `accepted`
    // addressed to the fake caller used to put every connected client into the voice call
    // (MICA-277). Exact equality, not `arrayContaining`: the whole point is what is absent.
    // `speaker: false` because this suite runs with no pma-voice (MICA-246).
    expect(emitCalls()).toEqual([['mica:client:phone:accepted', 2, { callId, speaker: false }]]);
  });

  /**
   * MICA-277. `micacall`'s caller is `-1`, and in FiveM `emitNet(event, -1)` reaches
   * **every** client. When the target ended an injected call themselves, `endActiveCall`
   * notified "the other side" — the console — and `client/services/Call.ts` acts on
   * `phone:ended` unconditionally, so one admin test call knocked the whole server out of
   * their calls. Nothing in the suite distinguished "emitted to one player" from "emitted
   * to everyone" before this: every assertion filtered for the event it wanted.
   */
  it('never emits to a source nobody is connected on, however the injected call ends', async () => {
    injectIncomingCall(2, '555-9999');
    await fire(ANSWER, 2);
    (globalThis as any).emitNet.mockClear();

    // The target hangs up through the real handler; the other side is the console's sentinel.
    await fire(END, 2);

    const toNobody = emitCalls().filter(([, src]) => !Number.isInteger(src) || src <= 0);
    expect(toNobody).toEqual([]);
    // The target is told, as whoever ends a call always is (MICA-232) — and only the target.
    expect(endedCalls()).toEqual([['mica:client:phone:ended', 2]]);
  });

  it('notifies only the real party and logs on their side alone', async () => {
    injectIncomingCall(2, '555-9999');
    (globalThis as any).emitNet.mockClear();

    const ended = endActiveCallFor(2);

    expect(ended).toBe(true);
    expect(emitCalls()).toEqual([['mica:client:phone:ended', 2]]);

    // The log row is written after the phone it belongs to is resolved (MICA-282), so let
    // that settle before reading the inserts.
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  // `releaseResource`, not `__resetRegistry()`: the latter also resets `onLineReleased` to
  // a noop, silently unhooking the handler `Phone.ts` installs at import — after which the
  // release test below fails for a reason that looks nothing like its cause.
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
      expect.arrayContaining([
        // A line's far end has no voice, so its call is never offered a speaker (MICA-246).
        ['mica:client:phone:accepted', 1, { callId: expect.any(Number), speaker: false }]
      ])
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

  it('fails a forward to a connected player who has no phone number', async () => {
    // Not the same case as the one above, and the one a `getPlayer` check alone misses: this
    // source *is* connected, so the player lookup passes, and `getPlayerPhone` still answers
    // null — `FrameworkPlayer.phone` is nullable and core ESX has nowhere to keep a number.
    // The re-dial then has nothing to dial, and `placeCall` refuses a bad number silently, so
    // without checking what it returned the caller would be told nothing at all.
    bridge.players.set(LINE_HOLDER_SRC, 'CID_LINE');
    registerNumber(
      LINE,
      { onCall: () => ({ action: 'forward', source: LINE_HOLDER_SRC }) as const },
      'taxi'
    );

    await fire(START, 1, LINE);

    // The same observable result an unreachable number produces: the reset event, and one
    // zero-duration outgoing row so the caller's own Recents shows the attempt.
    expect(failedTo(1)).toHaveLength(1);
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toHaveLength(0);
    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE, 0]));
  });

  it('still pays for the blocklist lookup on a line, so the timing is flat', async () => {
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall }, 'taxi');

    await fire(START, 1, LINE);

    // Asserted on the citizenid deliberately: the question is whether the *target* blocked
    // the caller, and a line blocks nobody, so this asks about `''`. The query is the MICA-64
    // timing channel being held shut, not a block.
    expect(dbMock.scalar).toHaveBeenCalledWith(expect.any(String), ['', '555-0001']);
    expect(onCall).toHaveBeenCalled();
    expect(failedTo(1)).toHaveLength(0);
  });

  it.each([true, false])(
    'rings a line (blockable: %s) whatever the blocklist answers (MICA-278)',
    async (blockable) => {
      // `blockable` is about the line's texts reaching a player who blocked it; a call *to*
      // a line is the caller's own choice and nothing on a blocklist refuses it.
      dbMock.scalar.mockResolvedValue(1);
      const onCall = vi.fn(() => ({ action: 'accept' }) as const);
      registerNumber(LINE, { onCall, blockable }, 'taxi');

      await fire(START, 1, LINE);

      expect(dbMock.scalar).toHaveBeenCalledTimes(1);
      expect(onCall).toHaveBeenCalled();
      expect(failedTo(1)).toHaveLength(0);
    }
  );

  it('leaves a player-to-player call on the same number alone when the line is released', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    // The framework can hand a registered number to a real character at any time, and then
    // the dialled number on an ordinary call matches the released line's.
    bridge.players.set(LINE_HOLDER_SRC, 'CID_LINE');
    bridge.phones.set(LINE_HOLDER_SRC, LINE);
    await fire(START, 1, LINE);
    (globalThis as any).emitNet.mockClear();

    releaseResource('taxi');

    expect(endedCalls()).toHaveLength(0);
  });

  it('ends a live call on a line whose owning resource goes away', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    await fire(START, 1, LINE);
    (globalThis as any).emitNet.mockClear();

    releaseResource('taxi');

    // Without this the caller's phone stays on a call whose far end is a dead function ref.
    expect(endedCalls()).toEqual(expect.arrayContaining([['mica:client:phone:ended', 1]]));
  });

  /**
   * `askLine` waits on a handler owned by another resource, so the caller is mid-setup for
   * as long as that resource decides to take. Both cases below drive that window directly by
   * holding the verdict open, which is the only way to reach the state at all.
   */
  const pendingLine = () => {
    let answer!: (verdict: CallVerdict) => void;
    const onCall = vi.fn(() => new Promise<CallVerdict>((resolve) => (answer = resolve)));
    registerNumber(LINE, { onCall }, 'taxi');
    return { onCall, answer: (verdict: CallVerdict) => answer(verdict) };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('refuses a second call placed while the line handler is still thinking', async () => {
    const line = pendingLine();
    const first = placeCall(1, LINE);
    await settle();

    await fire(START, 1, '555-0002');

    // Refused as busy on the strength of the reservation alone — no `ActiveCall` exists yet.
    expect(failedTo(1)).toHaveLength(1);
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(0);

    line.answer({ action: 'accept' });
    await first;

    // And the first call is still the one that connects, rather than having been overwritten.
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toHaveLength(1);
  });

  it('does not connect a caller who hung up while the line handler was thinking', async () => {
    const line = pendingLine();
    const pending = placeCall(1, LINE);
    await settle();

    await fire(END, 1);
    line.answer({ action: 'accept' });
    await pending;

    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toHaveLength(0);

    // The reservation was released rather than stranded, so the caller can dial again.
    await fire(START, 1, '555-0002');
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
  });

  it('does not connect a caller whose line was released while the handler was thinking', async () => {
    const line = pendingLine();
    const pending = placeCall(1, LINE);
    await settle();

    // The owning resource stops mid-handler. `onLineReleased`'s sweep cannot help here — no
    // `ActiveCall` exists yet — so accepting after it would strand the caller on a call whose
    // far end is already gone, with only their own hangup to end it.
    releaseResource('taxi');
    line.answer({ action: 'accept' });
    await pending;

    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toHaveLength(0);
    expect(failedTo(1)).toHaveLength(1);

    // And the reservation went back, rather than leaving the caller permanently busy.
    await fire(START, 1, '555-0002');
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
  });
});

/**
 * MICA-276. `placeCall`'s answer names what happened to the call, so `CreateCall` can refuse
 * what the player's own phone already refused. Every refusal the caller was toasted about
 * has a word; the two silent early returns keep theirs.
 */
describe('placeCall: what it reports', () => {
  const LINE = '5559999';
  afterEach(() => releaseResource('taxi'));

  it('reports placed for a call that rings a player', async () => {
    await expect(placeCall(1, '555-0002')).resolves.toBe('placed');
  });

  it('reports placed for a call a line accepted', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    await expect(placeCall(1, LINE)).resolves.toBe('placed');
  });

  it('reports unreachable for a number nobody holds', async () => {
    await expect(placeCall(1, '555-0000')).resolves.toBe('unreachable');
  });

  it('reports unreachable for a line that rejected, with no word of its own', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'reject' }) as const }, 'taxi');
    await expect(placeCall(1, LINE)).resolves.toBe('unreachable');
  });

  it('reports a blocked caller as unreachable, after the same blocklist lookup (MICA-64)', async () => {
    dbMock.scalar.mockResolvedValue(1);
    await expect(placeCall(1, '555-0002')).resolves.toBe('unreachable');

    // The return value must not be a new tell: an unreachable number pays for the same
    // query, so neither the word nor the wait separates the two.
    dbMock.scalar.mockClear();
    dbMock.scalar.mockResolvedValue(null);
    await expect(placeCall(1, '555-0000')).resolves.toBe('unreachable');
    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
  });

  it('reports busy for a self-call', async () => {
    await expect(placeCall(1, '555-0001')).resolves.toBe('busy');
  });

  it('reports busy for a target already on a call', async () => {
    await fire(START, 1, '555-0002');
    await expect(placeCall(3, '555-0002')).resolves.toBe('busy');
  });

  it('reports busy for a caller already on a call, on the line path too', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    await fire(START, 1, '555-0002');
    await expect(placeCall(1, LINE)).resolves.toBe('busy');
  });

  it('reports unreachable for a forward to a source nobody is connected on', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'forward', source: 99 }) as const }, 'taxi');
    await expect(placeCall(1, LINE)).resolves.toBe('unreachable');
  });

  it("passes a forwarded call's own answer through", async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'forward', source: 2 }) as const }, 'taxi');
    await expect(placeCall(1, LINE)).resolves.toBe('placed');
  });

  it('keeps the silent early returns', async () => {
    await expect(placeCall(1, 42)).resolves.toBe('invalid_target');
    await expect(placeCall(99, '555-0002')).resolves.toBe('caller_has_no_phone');
  });
});

// micaOS does not register 911 as a line of its own — see the docblock above
// `currentEmergencyNumber` in `Phone.ts` for why. These cover the ruling that came out of
// that decision: the exemption lives entirely in `placeCall`'s direct comparison, so it holds
// whether nobody is on the number, a script line is (MICA-226's original ask), or a real
// dispatcher is (the case the ruling turned on).
describe('start: the emergency number is exempt without needing a line (MICA-226)', () => {
  const EMERGENCY_SRC = 9;

  afterEach(() => {
    releaseResource('taxi');
    bridge.players.delete(EMERGENCY_SRC);
    bridge.phones.delete(EMERGENCY_SRC);
  });

  it('never asks the blocklist about the emergency number, even when nobody holds it', async () => {
    dbMock.scalar.mockResolvedValue(1); // would refuse any other number

    await fire(START, 1, '911');

    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('still asks the blocklist about an ordinary registered line', async () => {
    // Only the emergency number skips the query. A line pays for it like any other number
    // (the timing half of MICA-64) — it is never refused by it (MICA-278).
    registerNumber('5559999', { onCall: () => ({ action: 'accept' }) as const }, 'taxi');

    await fire(START, 1, '5559999');

    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
  });

  it('still exempts the emergency number when a real dispatcher holds it', async () => {
    bridge.players.set(EMERGENCY_SRC, 'CID_DISPATCH');
    bridge.phones.set(EMERGENCY_SRC, '911');
    dbMock.scalar.mockResolvedValue(1);

    await fire(START, 1, '911');

    expect(dbMock.scalar).not.toHaveBeenCalled();
  });
});

/**
 * MICA-232. `endActiveCall` used to skip whichever side ended the call, on the theory that it
 * already knew. It does not always: a dying battery sends `phone:end` from
 * `client/services/Battery.ts` with the call UI and the voice channel still up, and an answer
 * racing a hang-up can leave the ender's client believing it connected. Both real parties are
 * told now, every time; the client's `ended` handler is idempotent.
 */
describe('the side that ends a call is told it ended', () => {
  it('on a hang-up through phone:end, by the caller', async () => {
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    (globalThis as any).emitNet.mockClear();

    await fire(END, 1);

    expect(endedCalls()).toEqual([
      ['mica:client:phone:ended', 1],
      ['mica:client:phone:ended', 2]
    ]);
  });

  it('on a battery-drain end, which reaches the server as phone:end from a live call', async () => {
    // The client's drain path has no event of its own; it is `phone:end` from the target
    // whose phone just died, mid-call, before its own UI has torn anything down.
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    (globalThis as any).emitNet.mockClear();

    await fire(END, 2);

    expect(endedCalls()).toContainEqual(['mica:client:phone:ended', 2]);
    expect(endedCalls()).toContainEqual(['mica:client:phone:ended', 1]);
  });

  it('when the ender hangs up while a call is still ringing (the answer race)', async () => {
    await fire(START, 1, '555-0002');
    (globalThis as any).emitNet.mockClear();

    await fire(END, 1);
    // The target's answer lands after the call is gone and connects nothing.
    await fire(ANSWER, 2);

    expect(endedCalls()).toEqual([
      ['mica:client:phone:ended', 1],
      ['mica:client:phone:ended', 2]
    ]);
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:accepted')).toEqual([]);
  });

  it('on playerDropped, where the dropped source is emitted to as well', async () => {
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    (globalThis as any).emitNet.mockClear();

    await drop(2);

    expect(endedCalls()).toEqual([
      ['mica:client:phone:ended', 1],
      ['mica:client:phone:ended', 2]
    ]);
  });
});

/**
 * MICA-278. A line that accepted a call can hang it up, and only the resource that owns the
 * line can. Keyed by the `callId` the handler was given.
 */
describe('endLineCall: a line hangs up', () => {
  const LINE = '5559999';
  afterEach(() => {
    releaseResource('taxi');
    releaseResource('mechanic');
  });

  const acceptedCallId = (src: number): number => {
    const accepted = emitCalls().find(
      ([event, dest]) => event === 'mica:client:phone:accepted' && dest === src
    );
    if (!accepted) throw new Error(`no accepted call for ${src}`);
    return (accepted[2] as { callId: number }).callId;
  };

  it('ends the call for its owner, tells the caller, and logs it as answered', async () => {
    const onCall = vi.fn(() => ({ action: 'accept' }) as const);
    registerNumber(LINE, { onCall }, 'taxi');
    await placeCall(1, LINE);
    const callId = acceptedCallId(1);
    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ callId }));

    expect(endLineCall(callId, 'taxi')).toBe('ended');

    expect(endedCalls()).toEqual([['mica:client:phone:ended', 1]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The caller's outgoing row; the line has no citizenid and gets none.
    const inserts = createCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE]));

    // The caller is free again, and the id is spent.
    await fire(START, 1, '555-0002');
    expect(emitCalls().filter(([event]) => event === 'mica:client:phone:incoming')).toHaveLength(1);
    expect(endLineCall(callId, 'taxi')).toBe('no_such_call');
  });

  it('refuses a resource that does not own the line, and leaves the call up', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    registerNumber('5558888', { onCall: () => ({ action: 'accept' }) as const }, 'mechanic');
    await placeCall(1, LINE);
    const callId = acceptedCallId(1);

    expect(endLineCall(callId, 'mechanic')).toBe('not_owner');

    expect(endedCalls()).toHaveLength(0);
    // Still on the call: a second dial from the same caller is refused as busy.
    await expect(placeCall(1, '555-0002')).resolves.toBe('busy');
  });

  it('refuses a player-to-player call, whoever asks', async () => {
    await placeCall(1, '555-0002');
    const callId = (
      emitCalls().find(([event]) => event === 'mica:client:phone:incoming')![2] as {
        callId: number;
      }
    ).callId;

    expect(endLineCall(callId, 'taxi')).toBe('no_such_call');
    expect(endedCalls()).toHaveLength(0);
  });

  it('refuses a call the line forwarded — that is a call between two players', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'forward', source: 2 }) as const }, 'taxi');
    await placeCall(1, LINE);
    const incoming = emitCalls().find(([event]) => event === 'mica:client:phone:incoming')!;
    const callId = (incoming[2] as { callId: number }).callId;

    expect(endLineCall(callId, 'taxi')).toBe('no_such_call');
    expect(endedCalls()).toHaveLength(0);
  });

  it('refuses an id that is not an integer or names no call', () => {
    expect(endLineCall('123456', 'taxi')).toBe('no_such_call');
    expect(endLineCall(1.5, 'taxi')).toBe('no_such_call');
    expect(endLineCall(123456, 'taxi')).toBe('no_such_call');
  });
});

/**
 * MICA-246. The wiring between the call state machine and `../lib/speakerphone.ts`: who may
 * switch a speaker on, what the phones are told, and that ending the call lets go of every
 * bystander. The scan itself — range, cap, exclusions — is `speakerphone.test.ts`.
 */
describe('speakerphone', () => {
  const SPEAKER = 'mica:server:phone:speaker';
  const channels = new Map<number, number>();
  const coords: Record<string, [number, number, number]> = {};
  let ready = true;
  const setCall = vi.fn((src: number, channel: number) => {
    if (channel === 0) channels.delete(src);
    else channels.set(src, channel);
  });

  beforeEach(() => {
    channels.clear();
    setCall.mockClear();
    ready = true;
    __setVoiceBackend({
      ready: () => ready,
      setCall,
      channelOf: (src) => channels.get(src) ?? 0,
      clearChannel: (src) => channels.delete(src)
    });
    for (const key of Object.keys(coords)) delete coords[key];
    coords['1'] = [0, 0, 0];
    coords['2'] = [500, 0, 0];
    coords['3'] = [1, 1, 0];
    (globalThis as any).GetPlayerPed = (src: string) => (coords[src] ? `ped-${src}` : 0);
    (globalThis as any).DoesEntityExist = (ped: string) => Boolean(coords[String(ped).slice(4)]);
    (globalThis as any).GetEntityCoords = (ped: string) => coords[String(ped).slice(4)];
  });

  afterEach(() => {
    __setVoiceBackend();
    delete (globalThis as any).GetPlayerPed;
    delete (globalThis as any).DoesEntityExist;
    delete (globalThis as any).GetEntityCoords;
  });

  const speaker = async (src: number, enabled: unknown) => {
    (globalThis as any).source = src;
    const handler = handlers.get(SPEAKER);
    if (!handler) throw new Error(`no handler for ${SPEAKER}`);
    await handler(7, { enabled });
    return emitCalls()
      .filter(([event, dest]) => event === 'mica:client:phone:speaker' && dest === src)
      .at(-1)?.[3];
  };

  const connect = async () => {
    await fire(START, 1, '555-0002');
    await fire(ANSWER, 2);
    const accepted = emitCalls().find(([event]) => event === 'mica:client:phone:accepted')!;
    return accepted[2] as { callId: number; speaker: boolean };
  };

  const listenPushes = (src: number) =>
    emitCalls()
      .filter(([event, dest]) => event === 'mica:client:phone:speakerListen' && dest === src)
      .map(([, , payload]) => payload);

  it('offers the speaker to both parties when the voice setup can carry one', async () => {
    await connect();
    const accepted = emitCalls().filter(([event]) => event === 'mica:client:phone:accepted');
    expect(accepted.map(([, dest, payload]) => [dest, (payload as any).speaker])).toEqual([
      [1, true],
      [2, true]
    ]);
  });

  it('hides it when the voice setup cannot -- and refuses the request anyway', async () => {
    ready = false;
    const { speaker: offered } = await connect();

    expect(offered).toBe(false);
    expect(await speaker(1, true)).toEqual({ ok: false, enabled: false });
    expect(setCall).not.toHaveBeenCalled();
  });

  it('puts a bystander in the call channel, and tells them only how loud', async () => {
    const { callId } = await connect();

    expect(await speaker(1, true)).toEqual({ ok: true, enabled: true });
    expect(setCall).toHaveBeenCalledWith(3, callId);
    expect(listenPushes(3)).toEqual([{ listening: true, volume: 30 }]);
  });

  it('refuses a ringing call -- nothing is connected to hear', async () => {
    await fire(START, 1, '555-0002');

    expect(await speaker(1, true)).toEqual({ ok: false, enabled: false });
    expect(setCall).not.toHaveBeenCalled();
  });

  it('refuses a player who is not a party to any call', async () => {
    await connect();

    expect(await speaker(3, true)).toEqual({ ok: false, enabled: false });
    expect(setCall).not.toHaveBeenCalled();
  });

  it('refuses a payload that is not a boolean, before any of it runs', async () => {
    await connect();
    const reply = await speaker(1, 'yes');

    expect(reply).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(setCall).not.toHaveBeenCalled();
  });

  it('lets every bystander go when the call ends, whoever ends it', async () => {
    const { callId } = await connect();
    await speaker(1, true);
    expect(channels.get(3)).toBe(callId);

    await fire(END, 2);

    expect(setCall).toHaveBeenLastCalledWith(3, 0);
    expect(channels.has(3)).toBe(false);
    expect(listenPushes(3).at(-1)).toEqual({ listening: false });
  });

  it('lets them go when the speaker is switched off', async () => {
    await connect();
    await speaker(1, true);

    expect(await speaker(1, false)).toEqual({ ok: true, enabled: false });
    expect(channels.has(3)).toBe(false);
    expect(listenPushes(3).at(-1)).toEqual({ listening: false });
  });

  it('lets them go when the speaker holder drops', async () => {
    await connect();
    await speaker(1, true);

    await drop(1);

    expect(channels.has(3)).toBe(false);
  });

  it('never offers a speaker on a call a line answered', async () => {
    registerNumber('555-7777', { onCall: () => ({ action: 'accept' }) as const }, 'taxi');
    await fire(START, 1, '555-7777');

    const accepted = emitCalls().find(([event]) => event === 'mica:client:phone:accepted')!;
    expect((accepted[2] as { speaker: boolean }).speaker).toBe(false);
    expect(await speaker(1, true)).toEqual({ ok: false, enabled: false });
    releaseResource('taxi');
  });
});

/**
 * MICA-307. A line that answers `ring` rings several players at once and the first to answer
 * takes the call. What is under test is the call state: who is rung, who is let go and told,
 * who writes a call-log row, and that the answered call is an ordinary player-to-player one.
 */
describe('group ring (MICA-307)', () => {
  const LINE = '911';
  const OWNER = 'dispatch';
  const INCOMING = 'mica:client:phone:incoming';
  const ENDED = 'mica:client:phone:ended';
  const ACCEPTED = 'mica:client:phone:accepted';

  beforeEach(() => {
    bridge.players.set(5, 'CID_FIVE');
    bridge.phones.set(5, '555-0005');
    bridge.players.set(6, 'CID_SIX');
    bridge.phones.set(6, '555-0006');
    // Connected, but the framework has no number for them: an ordinary ESX shape.
    bridge.players.set(7, 'CID_NOPHONE');
  });

  afterEach(() => {
    releaseResource(OWNER);
    for (const src of [5, 6, 7]) {
      bridge.players.delete(src);
      bridge.phones.delete(src);
    }
  });

  const ringLine = (sources: unknown) =>
    registerNumber(
      LINE,
      { label: 'Emergency', onCall: () => ({ action: 'ring', sources }) as CallVerdict },
      OWNER
    );

  const sent = (event: string) =>
    emitCalls()
      .filter(([name]) => name === event)
      .map(([, dest]) => dest);

  const incomingPayloads = () =>
    emitCalls()
      .filter(([name]) => name === INCOMING)
      .map(([, dest, payload]) => [dest, payload]);

  it('rings every candidate with the line it came in on, and tells the caller nothing yet', async () => {
    ringLine([5, 6]);
    expect(await placeCall(1, LINE)).toBe('placed');

    const callId = (incomingPayloads()[0][1] as { callId: number }).callId;
    expect(incomingPayloads()).toEqual([
      [5, { from: '555-0001', callId, line: { number: LINE, label: 'Emergency' } }],
      [6, { from: '555-0001', callId, line: { number: LINE, label: 'Emergency' } }]
    ]);
    expect(sent(ACCEPTED)).toEqual([]);
    // Every candidate holds the call while it rings, so the busy checks hold for them.
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([true, true, true]);
  });

  it('labels the line with its number when it has no label', async () => {
    registerNumber(LINE, { onCall: () => ({ action: 'ring', sources: [5] }) }, OWNER);
    await placeCall(1, LINE);
    expect(incomingPayloads()[0][1]).toMatchObject({ line: { number: LINE, label: LINE } });
  });

  it('gives the call to the first to answer, ends it for the rest, and logs no row for them', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    await fire(ANSWER, 6);

    expect(sent(ACCEPTED)).toEqual([1, 6]);
    expect(sent(ENDED)).toEqual([5]);
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([true, false, true]);

    // A late answer from the loser finds nothing: they were let go.
    await fire(ANSWER, 5);
    expect(sent(ACCEPTED)).toEqual([1, 6]);

    await fire(END, 1);
    const rows = createCalls().map(([, params]) => params);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE]));
    expect(rows[1]).toEqual(expect.arrayContaining(['CID_SIX', 'incoming', '555-0001']));
    expect(rows.some((params) => params.includes('CID_FIVE'))).toBe(false);
  });

  it("writes the winner's row on the phone that rang, found by their own number", async () => {
    // `readPhoneIdByNumber` answers only for the winner's own number. Looked up by the line's
    // number instead, the row would fall back to `phoneForCitizen` and land on TEST_PHONE_ID.
    dbMock.single.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === '555-0006' ? { phone_id: 'PHONE_OF_SIX' } : null
    );
    try {
      ringLine([5, 6]);
      await placeCall(1, LINE);
      await fire(ANSWER, 6);
      await fire(END, 6);

      const incoming = createCalls()
        .map(([, params]) => params)
        .find((params) => params.includes('CID_SIX'));
      expect(incoming).toEqual(expect.arrayContaining(['CID_SIX', 'PHONE_OF_SIX', 'incoming']));
    } finally {
      dbMock.single.mockReset();
    }
  });

  it('answers under a fresh call id, so a loser holds an id that names nothing', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);
    const rungId = (incomingPayloads()[0][1] as { callId: number }).callId;

    await fire(ANSWER, 6);

    const accepted = emitCalls().filter(([event]) => event === ACCEPTED);
    const ids = accepted.map(([, , payload]) => (payload as { callId: number }).callId);
    expect(new Set(ids).size).toBe(1);
    const [answeredId] = ids;
    expect(answeredId).not.toBe(rungId);

    // The old id names nothing; the call lives on under the new one.
    expect(__callById(rungId)).toBeUndefined();
    expect(__callById(answeredId)).toMatchObject({ caller: 1, target: 6 });

    // And ending works under the new id, from either side, with the rows a call writes.
    await fire(END, 6);
    expect(__callById(answeredId)).toBeUndefined();
    expect(sent(ENDED)).toEqual([5, 1, 6]);
    expect([isInCall(1), isInCall(6)]).toEqual([false, false]);
    const rows = createCalls().map(([, params]) => params);
    expect(rows).toEqual([
      expect.arrayContaining(['CID_CALLER', 'outgoing', LINE]),
      expect.arrayContaining(['CID_SIX', 'incoming', '555-0001'])
    ]);
  });

  it('applies max after the busy filter, so busy staff with low ids do not hide free ones', async () => {
    const staff = Array.from({ length: 12 }, (_, i) => 10 + i);
    for (const src of staff) {
      bridge.players.set(src, `CID_${src}`);
      bridge.phones.set(src, `555-00${src}`);
    }
    try {
      for (const src of staff.slice(0, 10)) injectIncomingCall(src, '5550100');
      (globalThis as any).emitNet.mockClear();
      registerNumber(
        LINE,
        { onCall: () => ({ action: 'ring', sources: staff, max: 10 }) as CallVerdict },
        OWNER
      );

      expect(await placeCall(1, LINE)).toBe('placed');

      expect(incomingPayloads().map(([dest]) => dest)).toEqual([20, 21]);
    } finally {
      for (const src of staff) {
        endActiveCallFor(src);
        bridge.players.delete(src);
        bridge.phones.delete(src);
      }
    }
  });

  it('rings at most max of those left, in the order given', async () => {
    registerNumber(
      LINE,
      { onCall: () => ({ action: 'ring', sources: [6, 5, 3], max: 2 }) as CallVerdict },
      OWNER
    );
    await placeCall(1, LINE);
    expect(incomingPayloads().map(([dest]) => dest)).toEqual([6, 5]);
    expect(isInCall(3)).toBe(false);
  });

  it('never rings more than RING_MAX, whatever max says', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 100 + i);
    for (const src of many) {
      bridge.players.set(src, `CID_${src}`);
      bridge.phones.set(src, `555-1${src}`);
    }
    try {
      registerNumber(
        LINE,
        { onCall: () => ({ action: 'ring', sources: many, max: 200 }) as CallVerdict },
        OWNER
      );
      await placeCall(1, LINE);
      expect(incomingPayloads()).toHaveLength(32);
    } finally {
      for (const src of many) {
        bridge.players.delete(src);
        bridge.phones.delete(src);
      }
    }
  });

  it('lets a second answer arriving after the first change nothing', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);
    await fire(ANSWER, 5);
    await fire(ANSWER, 6);
    expect(sent(ACCEPTED)).toEqual([1, 5]);
  });

  it('ends it for every candidate when the caller hangs up mid-ring', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    await fire(END, 1);

    expect(sent(ENDED).sort()).toEqual([1, 5, 6]);
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([false, false, false]);
    const rows = createCalls().map(([, params]) => params);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE, 0]));
  });

  it('ends it for every candidate when the caller drops mid-ring', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    await drop(1);

    expect(sent(ENDED).sort()).toEqual([1, 5, 6]);
    expect([isInCall(5), isInCall(6)]).toEqual([false, false]);
  });

  it('releases one candidate per decline, and the last decline ends the call', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    await fire(END, 5);
    expect(sent(ENDED)).toEqual([5]);
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([true, false, true]);
    expect(createCalls()).toHaveLength(0);

    await fire(END, 6);
    expect(sent(ENDED)).toEqual([5, 6, 1]);
    expect(isInCall(1)).toBe(false);
    const rows = createCalls().map(([, params]) => params);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE, 0]));
  });

  it('releases a candidate who drops, and keeps ringing the rest', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    await drop(5);

    expect(sent(ENDED)).toEqual([5]);
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([true, false, true]);

    await fire(ANSWER, 6);
    expect(sent(ACCEPTED)).toEqual([1, 6]);
  });

  it('skips a candidate already on a call, the caller, and anyone with no number', async () => {
    await fire(START, 3, '555-0006'); // 6 is now busy, ringing from 3
    (globalThis as any).emitNet.mockClear();
    ringLine([1, 5, 6, 7, 99]);

    await placeCall(1, LINE);

    expect(incomingPayloads().map(([dest]) => dest)).toEqual([5]);
  });

  it('fails as unreachable, in MICA-64 shape, when nobody is left to ring', async () => {
    await fire(START, 3, '555-0005'); // 5 busy
    (globalThis as any).emitNet.mockClear();
    ringLine([1, 5, 7]);

    expect(await placeCall(1, LINE)).toBe('unreachable');
    // `logCall` is fire-and-forget; let its insert land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failedTo(1)).toHaveLength(1);
    expect(isInCall(1)).toBe(false);
    const rows = createCalls().map(([, params]) => params);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', LINE, 0]));
  });

  it('fails a malformed ring list as unreachable, like any other bad verdict', async () => {
    ringLine([5, 'six']);
    expect(await placeCall(1, LINE)).toBe('unreachable');
    expect(incomingPayloads()).toEqual([]);
  });

  it('skips a candidate who started a call of their own while the handler was thinking', async () => {
    let answer!: (verdict: CallVerdict) => void;
    registerNumber(
      LINE,
      { onCall: () => new Promise<CallVerdict>((resolve) => (answer = resolve)) },
      OWNER
    );
    const pending = placeCall(1, LINE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await fire(START, 5, '555-0003'); // 5 rings 3 inside the window
    answer({ action: 'ring', sources: [5, 6] });
    await pending;

    expect(incomingPayloads().map(([dest]) => dest)).toEqual([3, 6]);
    // 5's own call is untouched by the group: still ringing 3.
    expect(isInCall(5)).toBe(true);
    await fire(END, 6);
    expect(isInCall(5)).toBe(true);
  });

  it('does not ring anyone for a caller who hung up while the handler was thinking', async () => {
    let answer!: (verdict: CallVerdict) => void;
    registerNumber(
      LINE,
      { onCall: () => new Promise<CallVerdict>((resolve) => (answer = resolve)) },
      OWNER
    );
    const pending = placeCall(1, LINE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await fire(END, 1);
    answer({ action: 'ring', sources: [5, 6] });
    await pending;

    expect(incomingPayloads()).toEqual([]);
    expect([isInCall(5), isInCall(6)]).toEqual([false, false]);
  });

  it('ends a group call still ringing when its line is released', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);

    releaseResource(OWNER);

    expect(sent(ENDED).sort()).toEqual([1, 5, 6]);
    expect([isInCall(1), isInCall(5), isInCall(6)]).toEqual([false, false, false]);
  });

  it('leaves an answered group call up when its line is released', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);
    await fire(ANSWER, 5);
    (globalThis as any).emitNet.mockClear();

    releaseResource(OWNER);

    expect(sent(ENDED)).toEqual([]);
    expect([isInCall(1), isInCall(5)]).toEqual([true, true]);
  });

  it('makes the answered call an ordinary one: speaker offered, not endLineCall-able', async () => {
    __setVoiceBackend({
      ready: () => true,
      setCall: vi.fn(),
      channelOf: () => 0,
      clearChannel: () => {}
    });
    try {
      ringLine([5, 6]);
      await placeCall(1, LINE);
      await fire(ANSWER, 5);

      const accepted = emitCalls().filter(([event]) => event === ACCEPTED);
      expect(accepted.map(([, dest, payload]) => [dest, (payload as any).speaker])).toEqual([
        [1, true],
        [5, true]
      ]);
      const { callId } = accepted[0][2] as { callId: number };
      expect(endLineCall(callId, OWNER)).toBe('no_such_call');
      expect(isInCall(5)).toBe(true);
    } finally {
      __setVoiceBackend();
    }
  });

  it('refuses endLineCall for a group call that is still ringing', async () => {
    ringLine([5, 6]);
    await placeCall(1, LINE);
    const { callId } = incomingPayloads()[0][1] as { callId: number };
    expect(endLineCall(callId, OWNER)).toBe('no_such_call');
  });
});
