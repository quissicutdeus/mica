import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { __resetCalls, injectIncomingCall, endActiveCallFor } from '../services/Phone';
import { __resetRateLimits, allow } from '../lib/rateLimit';

const START = 'gphone:server:phone:start';
const ANSWER = 'gphone:server:phone:answer';
const END = 'gphone:server:phone:end';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetCalls();
  adminState.isAdmin = true;
  dbMock.insert.mockResolvedValue(1);
  dbMock.query.mockResolvedValue([]);
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
    expect(callerSql).toMatch(/gphone_phone_call_log/);
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

    const ended = emitCalls().filter(([event]) => event === 'gphone:client:phone:ended');
    expect(ended).toEqual([['gphone:client:phone:ended', 2]]);

    const inserts = createCalls();
    expect(inserts[0][1]).toEqual(expect.arrayContaining(['CID_CALLER', 'outgoing', 0]));
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));

    // Both maps are fully cleared — the survivor can immediately place a new call.
    (globalThis as any).emitNet.mockClear();
    await fire(START, 2, '555-0003');
    expect(emitCalls().filter(([event]) => event === 'gphone:client:phone:incoming')).toHaveLength(
      1
    );
  });

  it('notifies the caller and logs missed when the target drops before answering', async () => {
    await fire(START, 1, '555-0002');
    await drop(2);

    const ended = emitCalls().filter(([event]) => event === 'gphone:client:phone:ended');
    expect(ended).toEqual([['gphone:client:phone:ended', 1]]);

    const inserts = createCalls();
    expect(inserts[1][1]).toEqual(expect.arrayContaining(['CID_TARGET', 'missed', 0]));
  });

  it('does nothing for a source with no active call', async () => {
    await drop(3);

    expect(emitCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
  });
});

// `notifyPlayer` fires its own `gphone:client:shell:notify` before the handler's own
// `phone:failed`, so every refusal below is asserted by filtering for the one event that
// tells the client to reset, not by the full call list.
const failedTo = (src: number) =>
  emitCalls().filter(([event, dest]) => event === 'gphone:client:phone:failed' && dest === src);

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
    expect(sql).toMatch(/gphone_phone_call_log/);
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
    expect(emitCalls().filter(([event]) => event === 'gphone:client:phone:incoming')).toHaveLength(
      0
    );
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

describe('injectIncomingCall / endActiveCallFor — gphonecall support', () => {
  it('rings the target with the given caller phone', async () => {
    const callId = injectIncomingCall(2, '555-9999');

    expect(callId).not.toBeNull();
    expect(emitCalls()).toEqual([
      ['gphone:client:phone:incoming', 2, { from: '555-9999', callId }]
    ]);
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
      expect.arrayContaining([['gphone:client:phone:accepted', 2, { callId }]])
    );
  });

  it('notifies only the real party and logs on their side alone', async () => {
    injectIncomingCall(2, '555-9999');
    (globalThis as any).emitNet.mockClear();

    const ended = endActiveCallFor(2);

    expect(ended).toBe(true);
    expect(emitCalls()).toEqual([['gphone:client:phone:ended', 2]]);

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
const incomingCalls = () =>
  emitCalls().filter(([event]) => event === 'gphone:client:phone:incoming');
const endedCalls = () => emitCalls().filter(([event]) => event === 'gphone:client:phone:ended');

describe('gphonecall command', () => {
  it('refuses a non-admin', async () => {
    adminState.isAdmin = false;

    await runCommand('gphonecall', 1);

    expect(incomingCalls()).toHaveLength(0);
  });

  it('refuses the console — there is no player source to ring', async () => {
    await runCommand('gphonecall', 0);

    expect(emitCalls()).toHaveLength(0);
  });

  it('rings the caller with a default number when no argument is given', async () => {
    await runCommand('gphonecall', 1);

    const incoming = emitCalls().find(([event]) => event === 'gphone:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5550100' }));
  });

  it('rings from a seeded character by first name', async () => {
    await runCommand('gphonecall', 1, ['Marla']);

    const incoming = emitCalls().find(([event]) => event === 'gphone:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5550101' }));
  });

  it('rings from an arbitrary literal number', async () => {
    await runCommand('gphonecall', 1, ['5559999']);

    const incoming = emitCalls().find(([event]) => event === 'gphone:client:phone:incoming');
    expect(incoming?.[2]).toEqual(expect.objectContaining({ from: '5559999' }));
  });

  it('refuses to ring someone already on a call', async () => {
    await runCommand('gphonecall', 1);
    (globalThis as any).emitNet.mockClear();

    await runCommand('gphonecall', 1);

    expect(incomingCalls()).toHaveLength(0);
  });

  it("end tears down the caller's own active call", async () => {
    await runCommand('gphonecall', 1);
    (globalThis as any).emitNet.mockClear();

    await runCommand('gphonecall', 1, ['end']);

    expect(endedCalls()).toEqual([['gphone:client:phone:ended', 1]]);
  });

  it('end on a caller with no active call does not throw or emit', async () => {
    await runCommand('gphonecall', 1, ['end']);

    expect(endedCalls()).toHaveLength(0);
  });
});
