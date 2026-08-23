import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers, globalHandlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const capturedGlobal = new Map<string, Function>();
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
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    globalHandlers: capturedGlobal
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({
  players: new Map<number, string>([
    [1, 'CID_CALLER'],
    [2, 'CID_TARGET']
  ]),
  phones: new Map<number, string>([
    [1, '555-0001'],
    [2, '555-0002']
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
import { __resetRateLimits } from '../lib/rateLimit';

const START = 'gphone:server:phone:start';
const ANSWER = 'gphone:server:phone:answer';
const END = 'gphone:server:phone:end';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.insert.mockResolvedValue(1);
  dbMock.query.mockResolvedValue([]);
  (globalThis as any).emitNet = vi.fn();
});

const fire = async (event: string, src: number, ...args: unknown[]) => {
  (globalThis as any).source = src;
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  handler(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createCalls = () =>
  (dbMock.insert as any).mock.calls.map((args: unknown[]) => args as [string, unknown[]]);

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

    (globalThis as any).source = 1;
    const dropHandler = globalHandlers.get('playerDropped');
    if (!dropHandler) throw new Error('no handler for playerDropped');
    dropHandler();
    await new Promise((resolve) => setTimeout(resolve, 0));

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
