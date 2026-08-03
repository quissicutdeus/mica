import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));

import { appEventChannel } from '../lib/appEvents';
import { __setResourceLookup } from '../lib/FrameworkBridge';
import { APP_EVENT_NET_EVENT, parseAppEventEnvelope } from '@shared/appEvents';

/**
 * Pushing to a specific player's app.
 *
 * The outcome is a discriminated union rather than a boolean, and most of these hold that line:
 * a caller must not be able to read "the recipient was offline" as "the recipient was told".
 */

const online = (map: Record<number, string>) =>
  __setResourceLookup((name) =>
    name === 'qbx_core'
      ? {
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

describe('push', () => {
  it('sends on the one literal net event, in a parseable envelope', () => {
    // The name is a literal in shared/ so `eventNames.test.ts` checks it; a templated
    // per-app name would be an unchecked one.
    online({ 5: 'CIT_A' });

    const result = appEventChannel('blabber').push('CIT_A', 'mention', { blab_id: 7 });

    expect(result).toEqual({ delivered: true, source: 5 });
    expect(emitted[0][0]).toBe(APP_EVENT_NET_EVENT);
    expect(emitted[0][1]).toBe(5);
    expect(parseAppEventEnvelope(emitted[0][2])).toMatchObject({
      app: 'blabber',
      event: 'mention',
      payload: { blab_id: 7 }
    });
  });

  it('reports an offline recipient rather than reporting success', () => {
    online({});

    const result = appEventChannel('blabber').push('CIT_GONE', 'mention');

    expect(result).toEqual({ delivered: false, reason: 'offline' });
    expect(emitted).toHaveLength(0);
  });

  it('refuses an oversized payload instead of hitching the server', () => {
    // Finding out that 4 MB does not fit as a stall is much worse than as a refusal.
    online({ 5: 'CIT_A' });

    const result = appEventChannel('blabber').push('CIT_A', 'mention', {
      blob: 'x'.repeat(20_000)
    });

    expect(result).toEqual({ delivered: false, reason: 'oversize' });
    expect(emitted).toHaveLength(0);
  });

  it('refuses a payload that cannot be serialised', () => {
    online({ 5: 'CIT_A' });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(appEventChannel('blabber').push('CIT_A', 'mention', cycle)).toEqual({
      delivered: false,
      reason: 'unserializable'
    });
  });

  it('refuses an event name that is not lower_snake_case', () => {
    online({ 5: 'CIT_A' });

    expect(() => appEventChannel('blabber').push('CIT_A', 'Mention!')).toThrow(/lower_snake_case/);
  });

  it('refuses a bad app id at channel construction, not at push time', () => {
    // A mistyped app id becomes a startup condition rather than a silent runtime miss.
    expect(() => appEventChannel('Not Valid')).toThrow(/lower_snake_case/);
  });
});

describe('pushMany', () => {
  it('takes one player snapshot for the whole fan-out', () => {
    /**
     * The cost this exists to avoid: `getSourceByCitizenId` walks every player per call, so
     * notifying forty followers was forty full walks.
     */
    let walks = 0;
    __setResourceLookup((name) =>
      name === 'qbx_core'
        ? {
            GetQBPlayers: () => {
              walks += 1;
              return {
                5: { PlayerData: { citizenid: 'CIT_A' } },
                6: { PlayerData: { citizenid: 'CIT_B' } }
              };
            }
          }
        : undefined
    );

    const result = appEventChannel('blabber').pushMany(['CIT_A', 'CIT_B', 'CIT_GONE'], 'mention');

    expect(walks).toBe(1);
    expect(result.delivered.sort()).toEqual(['CIT_A', 'CIT_B']);
    expect(result.offline).toEqual(['CIT_GONE']);
  });

  it('notifies one player once even if named twice', () => {
    online({ 5: 'CIT_A' });

    const result = appEventChannel('blabber').pushMany(['CIT_A', 'CIT_A'], 'mention');

    expect(result.delivered).toEqual(['CIT_A']);
    expect(emitted).toHaveLength(1);
  });
});
