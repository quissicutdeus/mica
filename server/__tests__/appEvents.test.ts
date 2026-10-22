// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));

import { appEventChannel } from '../lib/appEvents';
import { __setResourceLookup } from '../lib/FrameworkBridge';
import { APP_EVENT_NET_EVENT, parseAppEventEnvelope } from '@mica/shared/appEvents';
import * as notificationsService from '../services/Notifications';

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

  it('carries no citizenid or phone id in its payload, at any depth (MICA-433)', () => {
    online({ 5: 'CIT_A' });

    appEventChannel('blabber').push('CIT_A', 'mention', {
      blab_id: 7,
      citizenid: 'CIT_A',
      row: { id: 1, device_id: 'PHONE_1', body: 'x' }
    });

    expect(parseAppEventEnvelope(emitted[0][2])?.payload).toEqual({
      blab_id: 7,
      row: { id: 1, body: 'x' }
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

  it('refuses a payload that cannot be serialized', () => {
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
    expect(result.delivered.toSorted()).toEqual(['CIT_A', 'CIT_B']);
    expect(result.offline).toEqual(['CIT_GONE']);
  });

  it('notifies one player once even if named twice', () => {
    online({ 5: 'CIT_A' });

    const result = appEventChannel('blabber').pushMany(['CIT_A', 'CIT_A'], 'mention');

    expect(result.delivered).toEqual(['CIT_A']);
    expect(emitted).toHaveLength(1);
  });

  describe('parseAppEventEnvelope', () => {
    it('carries a valid deep link through', () => {
      // The field was simply absent from the parser's return, so every toast fell back to
      // the push payload. That reads as working for a push whose payload happens to name
      // the same app, and goes nowhere for one that does not — which was all of Blabber's.
      const parsed = parseAppEventEnvelope({
        app: 'mail',
        event: 'received',
        payload: {},
        deepLink: 'mail?mailId=12'
      });
      expect(parsed?.deepLink).toBe('mail?mailId=12');
    });

    it('drops a link that does not parse rather than passing it on', () => {
      // Validated once at the boundary. `mail/12` is the shape the server used to write,
      // and handing it to `openApp` is what blanked the screen.
      const parsed = parseAppEventEnvelope({
        app: 'mail',
        event: 'received',
        payload: {},
        deepLink: 'mail/12'
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.deepLink).toBeUndefined();
    });
  });
});

/**
 * MICA-365: the envelope says whether the push wrote a notification row, so the shell re-reads
 * the shade and the badges only when there is something new to read. True exactly when a write
 * was started; never at the cost of the push itself.
 */
describe('persisted', () => {
  let batch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    online({ 5: 'CIT_A', 6: 'CIT_B' });
    const repo = notificationsService.getNotificationsRepository()!;
    expect(repo).not.toBeNull();
    batch = vi
      .spyOn(repo, 'createNotificationBatch')
      .mockResolvedValue(undefined as never) as never;
  });

  const sent = () => parseAppEventEnvelope(emitted.at(-1)![2])!;
  const notify = { title: 'New', message: 'hello' };

  it('is true when the push notifies, and the row is written', () => {
    appEventChannel('blabber').push('CIT_A', 'mention', {}, { notify });
    expect(sent().persisted).toBe(true);
    expect(batch).toHaveBeenCalledOnce();
  });

  it('is true for persist without notify — a row with no toast is still a row', () => {
    appEventChannel('blabber').push('CIT_A', 'mention', {}, { persist: true, body: 'quiet' });
    expect(sent().persisted).toBe(true);
    expect(sent().notify).toBeUndefined();
    expect(batch).toHaveBeenCalledOnce();
  });

  it('is false when persist is false, even with a toast', () => {
    appEventChannel('blabber').push('CIT_A', 'mention', {}, { notify, persist: false });
    expect(sent().persisted).toBe(false);
    expect(batch).not.toHaveBeenCalled();
  });

  it('is false for a bare push, which writes nothing', () => {
    appEventChannel('blabber').push('CIT_A', 'mention', { blab_id: 1 });
    expect(sent().persisted).toBe(false);
    expect(batch).not.toHaveBeenCalled();
  });

  it('is false when there is no notifications repository to write to', () => {
    vi.spyOn(notificationsService, 'getNotificationsRepository').mockReturnValue(null);
    appEventChannel('blabber').push('CIT_A', 'mention', {}, { notify });
    expect(sent().persisted).toBe(false);
  });

  it('carries the same answer to every recipient of a fan-out', () => {
    const result = appEventChannel('blabber').pushMany(
      ['CIT_A', 'CIT_B'],
      'mention',
      {},
      {
        notify
      }
    );
    expect(result.delivered).toEqual(['CIT_A', 'CIT_B']);
    expect(emitted.map((e) => parseAppEventEnvelope(e[2])!.persisted)).toEqual([true, true]);
    expect(batch).toHaveBeenCalledOnce();
  });

  it('never fails the push when the write it started fails', async () => {
    batch.mockRejectedValue(new Error('db down'));
    const result = appEventChannel('blabber').push('CIT_A', 'mention', {}, { notify });
    expect(result).toEqual({ delivered: true, source: 5 });
    expect(sent().persisted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('parses anything but exactly true as false, so a forged string cannot read as stored', () => {
    for (const persisted of [undefined, 'true', 1, null]) {
      expect(parseAppEventEnvelope({ app: 'mail', event: 'received', persisted })!.persisted).toBe(
        false
      );
    }
    expect(
      parseAppEventEnvelope({ app: 'mail', event: 'received', persisted: true })!.persisted
    ).toBe(true);
  });
});
