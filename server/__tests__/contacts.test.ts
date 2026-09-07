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

const bridge = vi.hoisted(() => ({ loaded: true, citizenid: 'CID_A', source: 5 }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () =>
      bridge.loaded
        ? { citizenid: bridge.citizenid, source: bridge.source, setMeta: () => {} }
        : null,
    getSourceByCitizenId: () => bridge.source,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

const proximity = vi.hoisted(() => ({ nearby: [] as { source: number; citizenid: string }[] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import { contacts } from '../services/Contacts';
import { __resetRateLimits } from '../lib/rateLimit';
import { TEST_PHONE_ID } from './phoneStub';

const SHARE_EVENT = 'mica:server:contacts:share';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  bridge.loaded = true;
  bridge.citizenid = 'CID_A';
  bridge.source = 5;
  proximity.nearby = [];
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).source = 5;
});

/** Fire-and-forget: the handler carries no callback id and nothing awaits its reply. */
const call = async (data: unknown) => {
  const handler = handlers.get(SHARE_EVENT);
  if (!handler) throw new Error(`no handler for ${SHARE_EVENT}`);
  handler(data);
  // The handler's own body is async; let its microtasks settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const pushesTo = (event: string) =>
  (globalThis.emitNet as any).mock.calls.filter((args: unknown[]) => args[0] === event);

describe('contacts:share', () => {
  it('does nothing for a source with no loaded character', async () => {
    bridge.loaded = false;

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });

  it('refuses a payload missing a name or phone', async () => {
    await call({ firstname: '', phone: '555-0100' });
    await call({ firstname: 'Ada', phone: '' });

    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });

  it('pushes the contact to every nearby, visible player', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'Ada', lastname: 'Lovelace', phone: '555-0100', avatar: '' });

    const incoming = pushesTo('mica:client:contacts:incoming');
    expect(incoming).toHaveLength(1);
    expect(incoming[0][1]).toBe(9);
    expect(incoming[0][2]).toMatchObject({
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '555-0100'
    });
  });

  it('fans out to more than one nearby player', async () => {
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect(pushesTo('mica:client:contacts:incoming')).toHaveLength(2);
  });

  it('tells the sender how many nearby phones received it', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'Ada', phone: '555-0100' });

    const push = pushesTo('mica:client:shell:appEvent');
    expect(push).toHaveLength(1);
    expect(push[0][2]).toMatchObject({
      app: 'contacts',
      event: 'share_result',
      payload: { count: 1 }
    });
  });

  it('says nobody is nearby without emitting an incoming share', async () => {
    proximity.nearby = [];

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect(pushesTo('mica:client:contacts:incoming')).toHaveLength(0);
    const push = pushesTo('mica:client:shell:appEvent');
    expect(push[0][2]).toMatchObject({ payload: { count: 0 } });
  });

  it('clamps an oversized name and phone rather than refusing the share', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'A'.repeat(200), phone: '5'.repeat(200) });

    const incoming = pushesTo('mica:client:contacts:incoming');
    expect(incoming[0][2].firstname.length).toBe(50);
    expect(incoming[0][2].phone.length).toBe(20);
  });

  it('clamps an oversized avatar rather than shipping it uncapped', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'Ada', phone: '555-0100', avatar: 'A'.repeat(20_000_000) });

    const incoming = pushesTo('mica:client:contacts:incoming');
    // `blob` is capped at MAX_LENGTH_BY_TYPE.blob (16777215) in `defineService.ts` — the
    // exact number is an implementation detail of that table; what matters here is that
    // something bounded it well short of the 20,000,000 sent.
    expect(incoming[0][2].avatar.length).toBeLessThan(20_000_000);
    expect(incoming[0][2].avatar.length).toBeGreaterThan(0);
  });

  /**
   * MICA-155. `contacts:share` used to relay `firstname`/`lastname`/`phone`/`avatar`
   * straight from the payload with no sender attached at all — an impersonation primitive,
   * since an accepted card could rename a Messages thread off nothing but a phone-number
   * match with no way to tell who had actually sent it.
   */
  describe('sender identity is attached server-side, not read off the payload', () => {
    it('stamps the caller-derived citizenid, ignoring anything the payload sends for it', async () => {
      proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];
      bridge.citizenid = 'CID_A';

      await call({
        firstname: 'Ada',
        phone: '555-0100',
        // A modified client attempting to forge a sender.
        sender: { citizenid: 'CID_SPOOFED', name: 'Not Ada', phone: '555-9999' },
        citizenid: 'CID_SPOOFED'
      });

      const incoming = pushesTo('mica:client:contacts:incoming');
      expect(incoming[0][2].sender.citizenid).toBe('CID_A');
      expect(incoming[0][2].sender).not.toMatchObject({ citizenid: 'CID_SPOOFED' });
    });

    it('resolves to a different sender for a different connection, from the source alone', async () => {
      proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];
      bridge.citizenid = 'CID_C';
      bridge.source = 7;
      (globalThis as any).source = 7;

      await call({ firstname: 'Ada', phone: '555-0100' });

      const incoming = pushesTo('mica:client:contacts:incoming');
      expect(incoming[0][2].sender.citizenid).toBe('CID_C');
    });

    it('still carries the card fields the sender chose, unresolved against their own identity', async () => {
      // The card is arbitrary by design — sharing someone else's saved contact is the
      // feature, not a bug, so `phone`/`firstname` must not be forced to match the sender.
      proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

      await call({ firstname: 'Someone Else', phone: '555-7777' });

      const incoming = pushesTo('mica:client:contacts:incoming');
      expect(incoming[0][2].firstname).toBe('Someone Else');
      expect(incoming[0][2].phone).toBe('555-7777');
      expect(incoming[0][2].sender.citizenid).toBe('CID_A');
    });
  });
});

/**
 * MICA-142 — a nullable per-contact ringtone override, through the generic CRUD path
 * `defineService` derives (not the hand-written `share` handler above). `null` must stay
 * writable and must stay the default: it is what makes a contact fall back to the system
 * ringtone rather than being backfilled to `classic`.
 */
describe('contacts:ringtone (MICA-142)', () => {
  const genericCall = async (action: 'create' | 'update' | 'get', data: unknown) => {
    const handler = handlers.get(`mica:server:contacts:${action}`);
    if (!handler) throw new Error(`no handler for contacts:${action}`);
    await (handler as any)('cb-1', data);
  };

  const lastReplyTo = (event: string) => {
    const call = (globalThis.emitNet as any).mock.calls
      .filter((args: unknown[]) => args[0] === event)
      .pop();
    return call?.[3];
  };

  it('declares the value domain as the client RingtoneId union, nullable with no default', () => {
    // `contacts.repo` rather than only `contacts.resolved` — the allowlist §2.9 actually
    // checks a payload key against is the repository's, and the two must agree.
    expect(contacts.repo.tableColumns).toContain('ringtone');
    expect(contacts.resolved.columnRules.ringtone).toMatchObject({
      type: 'enum',
      values: ['classic', 'chime', 'beacon', 'pulse', 'ascent']
    });
  });

  it('is client-writable on create', async () => {
    dbMock.insert.mockResolvedValue(42);

    await genericCall('create', { firstname: 'Ada', phone: '555-0100', ringtone: 'chime' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toContain('`ringtone`');
    expect(params).toContain('chime');
  });

  it('accepts null on update, so a contact can fall back to the system ringtone', async () => {
    dbMock.update.mockResolvedValue(true);

    await genericCall('update', { id: 3, ringtone: null });

    expect(dbMock.update.mock.calls[0][1]).toContain(null);
  });

  it('rejects a value outside the union rather than forwarding it to SQL', async () => {
    await genericCall('update', { id: 3, ringtone: 'airhorn' });

    expect(dbMock.update).not.toHaveBeenCalled();
    const reply = lastReplyTo('mica:client:contacts:updated');
    expect(reply.error).toMatch(/'ringtone' must be one of/);
  });

  it('comes back on a read, so a saved override is not silently dropped', async () => {
    dbMock.query.mockResolvedValue([
      { id: 3, citizenid: 'CID_A', firstname: 'Ada', phone: '555-0100', ringtone: 'beacon' }
    ]);

    await genericCall('get', {});

    const reply = lastReplyTo('mica:client:contacts:receive');
    expect(reply).toEqual(
      expect.arrayContaining([expect.objectContaining({ ringtone: 'beacon' })])
    );
  });
});

/**
 * MICA-75. `restore` undoes a `delete` within the shared restore window — see
 * `Repository.restore` and `server/lib/retention.ts` for the mechanics this exercises
 * end-to-end through the registered net event.
 */
describe('contacts:restore (MICA-75)', () => {
  const genericCall = async (action: 'restore', data: unknown) => {
    const handler = handlers.get(`mica:server:contacts:${action}`);
    if (!handler) throw new Error(`no handler for contacts:${action}`);
    await (handler as any)('cb-1', data);
    return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
  };

  it('restores a deleted contact within the window, scoped to the caller citizenid', async () => {
    dbMock.update.mockResolvedValue(true);

    const reply = await genericCall('restore', { id: 3 });

    expect(reply).toEqual({ ok: true });
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('UPDATE `mica_contacts`');
    expect(String(sql)).toContain("`status` = 'deleted'");
    expect(params).toEqual([3, 'CID_A', TEST_PHONE_ID, 30]);
  });

  it('reports false rather than throwing once the window has passed', async () => {
    dbMock.update.mockResolvedValue(false);

    const reply = await genericCall('restore', { id: 3 });

    expect(reply).toEqual({ ok: false });
  });

  it('refuses a payload naming a citizenid, rather than quietly ignoring it', async () => {
    dbMock.update.mockResolvedValue(true);

    const reply = await genericCall('restore', { id: 3, citizenid: 'CID_VICTIM' });

    // The predicate was always the caller's own citizenid, and still is. What changed is
    // that a payload asking for somebody else's is refused rather than ignored — a hostile
    // key has no slot, so the request carrying it does not half-succeed.
    expect(reply).toMatchObject({ error: expect.stringContaining('citizenid') });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('honours an operator-configured restore window', async () => {
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_restore_window_days' ? '7' : fallback;
    dbMock.update.mockResolvedValue(true);

    await genericCall('restore', { id: 3 });

    (globalThis as any).GetConvar = previous;
    expect(dbMock.update.mock.calls[0][1]).toEqual([3, 'CID_A', TEST_PHONE_ID, 7]);
  });

  it('rejects a missing or invalid id before touching the database', async () => {
    const reply = await genericCall('restore', {});

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('is registered alongside the generic CRUD actions', () => {
    expect(handlers.has('mica:server:contacts:restore')).toBe(true);
    expect(contacts.resolved.id).toBe('contacts');
  });
});

/**
 * MICA-75-wiring: the "Recently Deleted" list itself. `status` is never
 * client-filterable (`Repository.ts`'s `NEVER_CLIENT_FILTERABLE`), so this is a named
 * action reading `Repository.findDeleted` directly rather than the generic `get`.
 */
describe('contacts:getDeleted (MICA-75-wiring)', () => {
  const call = async (data: unknown = {}) => {
    const handler = handlers.get('mica:server:contacts:getDeleted');
    if (!handler) throw new Error('no handler for contacts:getDeleted');
    await (handler as any)('cb-1', data);
    return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
  };

  it('reads only the caller’s own deleted rows, bounded to the restore window', async () => {
    dbMock.query.mockResolvedValue([{ id: 3, citizenid: 'CID_A', status: 'deleted' }]);

    const reply = await call();

    expect(reply).toEqual([{ id: 3, citizenid: 'CID_A', status: 'deleted' }]);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('FROM `mica_contacts`');
    expect(String(sql)).toContain("`status` = 'deleted'");
    expect(params).toEqual(['CID_A', TEST_PHONE_ID, 30]);
  });

  it('refuses a payload claiming a citizenid — the list takes no payload at all', async () => {
    const reply = await call({ citizenid: 'CID_VICTIM' });

    expect(reply).toMatchObject({ error: expect.stringContaining('payload') });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('is registered alongside restore', () => {
    expect(handlers.has('mica:server:contacts:getDeleted')).toBe(true);
  });
});
