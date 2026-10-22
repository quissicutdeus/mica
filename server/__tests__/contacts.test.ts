// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isRingtoneValue } from '@mica/shared/ownerConfig';
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
    // The framework's number for the character: their main phone, which a share must never
    // carry (MICA-343). Answered here so a regression that reads it is visible in the payload.
    getPlayerPhone: () => '555-0001',
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
import { duplicateEntry, oxmysqlRejection } from './oxmysqlRejection';

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
   * MICA-155 attached a `sender` to every share — citizenid, directory name and *active*
   * number — and sent it to every player in range. MICA-343 took it off: a card handed over
   * from a burner named the character and their main phone. The share is proximity-based, so
   * the receiver can see who is next to them; the payload is the card and nothing else.
   */
  describe('the share carries the card and nothing about the sender (MICA-343)', () => {
    it('relays the card fields, and nothing a payload names as the sender', async () => {
      proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

      await call({
        firstname: 'Ada',
        phone: '555-0100',
        // A modified client attempting to forge a sender.
        sender: { citizenid: 'CID_SPOOFED', name: 'Not Ada', phone: '555-9999' },
        citizenid: 'CID_SPOOFED'
      });

      const incoming = pushesTo('mica:client:contacts:incoming');
      expect(incoming).toHaveLength(1);
      expect(Object.keys(incoming[0][2]).toSorted()).toEqual([
        'avatar',
        'firstname',
        'lastname',
        'phone'
      ]);
      expect(incoming[0][2]).toMatchObject({ firstname: 'Ada', phone: '555-0100' });
    });

    it('names neither the citizen, their name, nor their main phone to the players in range', async () => {
      proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

      await call({ firstname: 'Someone Else', phone: '555-7777' });

      const incoming = pushesTo('mica:client:contacts:incoming');
      expect(incoming).toHaveLength(1);
      const wire = JSON.stringify(incoming[0][2]);
      expect(wire).not.toContain('CID_A');
      expect(wire).not.toContain('555-0001');
      expect(incoming[0][2]).not.toHaveProperty('sender');
      // The card the sender chose — someone else's, which is the feature — still arrives whole.
      expect(incoming[0][2]).toMatchObject({ firstname: 'Someone Else', phone: '555-7777' });
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

  it('declares a varchar held to isRingtoneValue, nullable with no default (MICA-256)', () => {
    // `contacts.repo` rather than only `contacts.resolved` — the allowlist §2.9 actually
    // checks a payload key against is the repository's, and the two must agree.
    expect(contacts.repo.tableColumns).toContain('ringtone');
    expect(contacts.resolved.columnRules.ringtone).toMatchObject({
      type: 'string',
      maxLength: 54,
      values: null
    });
    expect(contacts.resolved.columnRules.ringtone.accepts).toBe(isRingtoneValue);
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

  it('writes an owner sound id (MICA-256)', async () => {
    dbMock.update.mockResolvedValue(true);

    await genericCall('update', { id: 3, ringtone: 'owner:old_phone-ring' });

    expect(dbMock.update.mock.calls[0][1]).toContain('owner:old_phone-ring');
  });

  it.each([
    'airhorn',
    'owner:',
    'owner:.hidden',
    'owner:has space',
    'owner:../x',
    '<img src=x onerror=alert(1)>',
    'CLASSIC'
  ])('refuses %j rather than forwarding it to SQL', async (ringtone) => {
    await genericCall('update', { id: 3, ringtone });

    expect(dbMock.update).not.toHaveBeenCalled();
    const reply = lastReplyTo('mica:client:contacts:updated');
    expect(reply.error).toBe("'ringtone' is not a value this server accepts.");
  });

  it('refuses an owner id past the column width with the length message', async () => {
    await genericCall('update', { id: 3, ringtone: `owner:${'a'.repeat(49)}` });

    expect(dbMock.update).not.toHaveBeenCalled();
    const reply = lastReplyTo('mica:client:contacts:updated');
    expect(reply.error).toMatch(/'ringtone' is limited to 54 characters/);
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

  it('says so when another live contact on the phone holds the number now (MICA-335)', async () => {
    dbMock.update.mockRejectedValue(
      oxmysqlRejection(
        'UPDATE `mica_contacts` SET `status` = ...',
        [3, 'CID_A'],
        duplicateEntry(`${TEST_PHONE_ID}-555-0100`, 'device_phone_unique')
      )
    );

    expect(await genericCall('restore', { id: 3 })).toEqual({
      error: 'You already have a contact with that number.',
      key: 'server.contacts.numberTaken',
      params: undefined
    });
  });

  it('still answers the generic failure for any other reason', async () => {
    dbMock.update.mockRejectedValue(
      oxmysqlRejection(
        'UPDATE `mica_contacts` SET `status` = ...',
        [3],
        'Lock wait timeout exceeded'
      )
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await genericCall('restore', { id: 3 })).toMatchObject({ key: 'server.generic' });
  });
});

describe('one live contact per number on a phone (MICA-335)', () => {
  const field = (name: string) => contacts.resolved.fields.find((f) => f.name === name)?.def;

  it('keys the phone and the number of a live row only', () => {
    expect(contacts.resolved.indexes).toContainEqual(
      expect.objectContaining({
        name: 'device_phone_unique',
        columns: ['device_id', 'phone_key'],
        unique: true
      })
    );
    expect(field('phone_key')?.generatedAs).toBe(
      "CASE WHEN `status` = 'active' THEN `phone` ELSE NULL END"
    );
    // A deleted row holds no key, so the soft delete needs no revive.
    expect(contacts.resolved.uniqueAfterDelete).toMatchObject({ optOut: expect.any(String) });
  });

  it('never lets a payload write or read either new column', () => {
    expect(contacts.repo.writableColumns).not.toContain('default_number');
    expect(contacts.repo.writableColumns).not.toContain('phone_key');
    expect(contacts.resolved.listColumns).not.toContain('default_number');
    expect(contacts.resolved.listColumns).not.toContain('phone_key');
    expect(contacts.resolved.listColumns).toContain('phone');
  });

  describe('AddContact', () => {
    const addForPlayer = (item: Record<string, unknown>) =>
      (
        contacts.repo as unknown as {
          addForPlayer(citizenid: string, item: Record<string, unknown>): Promise<number>;
        }
      ).addForPlayer('CID_A', item);

    it('answers a fresh contact its new id', async () => {
      dbMock.insert.mockResolvedValue(41);

      await expect(addForPlayer({ firstname: 'Dispatch', phone: '911' })).resolves.toBe(41);
      expect(dbMock.scalar).not.toHaveBeenCalled();
    });

    it('answers the contact already there when the phone has the number', async () => {
      dbMock.insert.mockRejectedValue(
        oxmysqlRejection(
          'INSERT INTO `mica_contacts` ...',
          ['Dispatch', '911'],
          duplicateEntry(`${TEST_PHONE_ID}-911`, 'device_phone_unique')
        )
      );
      dbMock.scalar.mockResolvedValue(17);

      await expect(addForPlayer({ firstname: 'Dispatch', phone: '911' })).resolves.toBe(17);
      // Looked up as the key looks: by phone and live number, and by no citizen — a live row
      // still naming the phone's previous holder refuses the insert just the same.
      const [sql, params] = dbMock.scalar.mock.calls[0];
      expect(String(sql)).toContain('`device_id` = ? AND `phone_key` = ?');
      expect(String(sql)).not.toContain('`citizenid`');
      expect(params).toEqual([TEST_PHONE_ID, '911']);
    });

    it('fails, rather than answer nothing, when the refusing row is gone by the lookup', async () => {
      dbMock.insert.mockRejectedValue(
        oxmysqlRejection('INSERT ...', [], duplicateEntry('x-911', 'device_phone_unique'))
      );
      dbMock.scalar.mockResolvedValue(null);

      await expect(addForPlayer({ firstname: 'Dispatch', phone: '911' })).rejects.toThrow(
        /no longer holds/
      );
    });

    it('rethrows anything else, even with "Duplicate entry" among its parameters', async () => {
      const failure = oxmysqlRejection(
        'INSERT INTO `mica_contacts` ...',
        ["Duplicate entry '911' for key 'x'", '911'],
        'Lock wait timeout exceeded'
      );
      dbMock.insert.mockRejectedValue(failure);

      await expect(
        addForPlayer({ firstname: "Duplicate entry '911' for key 'x'", phone: '911' })
      ).rejects.toBe(failure);
      expect(dbMock.scalar).not.toHaveBeenCalled();
    });

    it('takes the errno mysql2 carries in-process as well', async () => {
      dbMock.insert.mockRejectedValue(
        Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' })
      );
      dbMock.scalar.mockResolvedValue(17);

      await expect(addForPlayer({ firstname: 'Dispatch', phone: '911' })).resolves.toBe(17);
    });
  });

  /**
   * A player saving a number the phone already holds live, by create or by edit, is told so in
   * words. The lock wait is the positive twin: the same path, any other failure, still the
   * generic answer — so the key is matched on the refusal, not on every throw.
   */
  describe('a player saving a number the phone already has', () => {
    const genericCall = async (action: 'create' | 'update', data: unknown) => {
      const handler = handlers.get(`mica:server:contacts:${action}`);
      if (!handler) throw new Error(`no handler for contacts:${action}`);
      await (handler as any)('cb-1', data);
      return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
    };
    const taken = oxmysqlRejection(
      'INSERT INTO `mica_contacts` ...',
      ['Ada', '555-0100'],
      duplicateEntry(`${TEST_PHONE_ID}-555-0100`, 'mica_contacts.device_phone_unique')
    );
    const lockWait = oxmysqlRejection('INSERT INTO `mica_contacts` ...', [], 'Lock wait timeout');

    it.each([
      ['create', { firstname: 'Ada', phone: '555-0100' }, 'insert'],
      ['update', { id: 3, phone: '555-0100' }, 'update']
    ] as const)('on %s, is told the number is taken', async (action, data, method) => {
      dbMock[method].mockRejectedValue(taken);
      expect(await genericCall(action, data)).toMatchObject({
        error: 'You already have a contact with that number.',
        key: 'server.contacts.numberTaken'
      });
    });

    it.each([
      ['create', { firstname: 'Ada', phone: '555-0100' }, 'insert'],
      ['update', { id: 3, phone: '555-0100' }, 'update']
    ] as const)(
      'on %s, any other failure is still the generic one',
      async (action, data, method) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        dbMock[method].mockRejectedValue(lockWait);
        expect(await genericCall(action, data)).toMatchObject({ key: 'server.generic' });
      }
    );
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

    // The owner's citizenid is the row's, never the reply's (MICA-433).
    expect(reply).toEqual([{ id: 3, status: 'deleted' }]);
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
