// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));

import { __setResourceLookup } from '../lib/FrameworkBridge';
import { APP_EVENT_NET_EVENT, parseAppEventEnvelope } from '@mica/shared/appEvents';
import type { JOB_CHANGE_EVENTS as Events } from '../lib/jobEvents';

/**
 * The job-change push (MICA-227).
 *
 * Each framework event the module listens to must push exactly one `jobs:changed` to the
 * player it names, nothing to anyone else, and never throw back into the framework's own
 * `TriggerEvent`. The handlers are captured from the real `on(...)` registrations rather
 * than called by name, so what is asserted is what the module registered — the argument
 * order is the part a comment cannot keep true.
 */

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
const netHandlers: string[] = [];
let JOB_CHANGE_EVENTS: typeof Events;

beforeAll(async () => {
  (globalThis as any).on = (name: string, fn: Handler) => handlers.set(name, fn);
  (globalThis as any).onNet = (name: string) => netHandlers.push(name);
  ({ JOB_CHANGE_EVENTS } = await import('../lib/jobEvents'));
});

const online = (map: Record<number, string>) =>
  __setResourceLookup((name) =>
    name === 'qbx_core'
      ? {
          GetPlayer: (src: number) =>
            map[src] ? { PlayerData: { citizenid: map[src], charinfo: {} } } : null,
          GetQBPlayers: () =>
            Object.fromEntries(
              Object.entries(map).map(([src, citizenid]) => [src, { PlayerData: { citizenid } }])
            )
        }
      : undefined
  );

let emitted: unknown[][] = [];

beforeEach(() => {
  emitted = [];
  (globalThis as any).emitNet = (...args: unknown[]) => emitted.push(args);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

const fire = (name: string, ...args: unknown[]) => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`nothing registered '${name}' with on()`);
  handler(...args);
};

describe('jobEvents registration', () => {
  it('registers every framework event locally, and none of them on the network', () => {
    // An `onNet` twin would be a client-reachable entry point the framework does not have.
    // `netHandlers` also sees the `mica:server:*` handlers the import graph registers, which
    // is fine; what must be absent is any of these names.
    for (const name of Object.values(JOB_CHANGE_EVENTS)) {
      expect(handlers.has(name), name).toBe(true);
      expect(netHandlers, name).not.toContain(name);
    }
  });
});

describe('a job change pushes a refetch', () => {
  const cases: [keyof typeof Events, unknown[]][] = [
    // qbx_core server/player.lua:266 and :1009 — (source, job)
    ['qbJobUpdate', [{ name: 'police', grade: { level: 2 } }]],
    // qbx_core server/player.lua:205 — (source, onDuty)
    ['qbSetDuty', [true]],
    // qbx_core server/player.lua:326 — (source, groupName, grade)
    ['qbxGroupUpdate', ['police', 3]],
    // es_extended — (playerId, job, lastJob)
    ['esxSetJob', [{ name: 'police' }, { name: 'unemployed' }]]
  ];

  it.each(cases)('%s reaches only the player whose job changed', (key, rest) => {
    online({ 5: 'CIT_A', 9: 'CIT_B' });

    fire(JOB_CHANGE_EVENTS[key], 5, ...rest);

    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe(APP_EVENT_NET_EVENT);
    expect(emitted[0][1]).toBe(5);
    expect(parseAppEventEnvelope(emitted[0][2])).toMatchObject({
      app: 'jobs',
      event: 'changed',
      payload: {}
    });
  });

  it('pushes once per event, not once per listener', () => {
    online({ 5: 'CIT_A' });
    fire(JOB_CHANGE_EVENTS.qbSetDuty, 5, false);
    fire(JOB_CHANGE_EVENTS.qbSetDuty, 5, true);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((call) => call[1] === 5)).toBe(true);
  });

  it('sends nothing, and does not throw, when the framework cannot name the player', () => {
    online({ 9: 'CIT_B' });
    expect(() => fire(JOB_CHANGE_EVENTS.qbJobUpdate, 5, { name: 'police' })).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 'five', undefined, null, {}])(
    'ignores %s as a source rather than resolving it',
    (src) => {
      online({ 5: 'CIT_A' });
      expect(() => fire(JOB_CHANGE_EVENTS.qbJobUpdate, src, {})).not.toThrow();
      expect(emitted).toHaveLength(0);
    }
  );

  it('accepts a numeric-string source, as a Lua caller may hand one', () => {
    online({ 5: 'CIT_A' });
    fire(JOB_CHANGE_EVENTS.esxSetJob, '5', {}, {});
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toBe(5);
  });

  it('never throws into the framework when the push itself fails', () => {
    online({ 5: 'CIT_A' });
    (globalThis as any).emitNet = () => {
      throw new Error('net down');
    };
    expect(() => fire(JOB_CHANGE_EVENTS.qbSetDuty, 5, true)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[jobEvents]'),
      expect.any(Error)
    );
  });
});
