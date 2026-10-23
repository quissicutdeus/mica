// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { dbMock, bridgeMock, auditMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  },
  bridgeMock: { FrameworkBridge: { getPlayer: vi.fn() } },
  auditMock: { AuditLogger: { log: vi.fn() } }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => bridgeMock);
vi.mock('../lib/AuditLogger', () => auditMock);

import { Repository } from '../lib/Repository';
import { ServiceEndpoint, ServiceOptions } from '../lib/ServiceEndpoint';
import { GENERIC_ERROR_MESSAGE, PlayerFacingError } from '../lib/errors';
import { __setDeviceResolvers, type RequestDeviceOptions } from '../lib/deviceIdentity';
import { TEST_PHONE_ID, TEST_TABLET_ID, installTestPhone } from './phoneStub';
import { defineContract } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';

interface TestRow {
  id: number;
  citizenid: string;
  title: string;
  content: string;
  status: string;
  created_at: string;
  updated_at: string;
}

class TestRepo extends Repository<TestRow> {
  protected tableName = 'mica_test';
  protected columns = ['id', 'citizenid', 'title', 'content', 'status', 'created_at', 'updated_at'];
  protected clientWritable = ['title', 'content'];
  protected clientFilterable = ['title'];
}

const OWNER = 'CIT_OWNER';

type Handler = (cbId: string, data: unknown, device?: unknown) => Promise<void>;

let handlers: Map<string, Handler>;
let emitted: unknown[][];

/** Build a ServiceEndpoint with `onNet` / `emitNet` captured so handlers can be driven. */
const mount = (options: ServiceOptions = {}) => {
  handlers = new Map();
  emitted = [];

  (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
    handlers.set(event, cb);
  };
  (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
    emitted.push(args);
  };
  (globalThis as Record<string, unknown>).source = 5;

  const repo = new TestRepo();
  const app = new ServiceEndpoint<TestRow>('test', repo, options);
  return { app, repo };
};

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:test:${action}`);
  if (!handler) throw new Error(`no handler registered for '${action}'`);
  await handler('cb-1', data);
};

/** The payload the last emitNet delivered back to the client. */
const lastReply = () => emitted[emitted.length - 1]?.[3] as any;
const sqlOf = (mockCall: unknown[] | undefined) =>
  String(mockCall?.[0]).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMock.FrameworkBridge.getPlayer.mockReturnValue({ citizenid: OWNER, source: 5 });
  dbMock.update.mockResolvedValue(true);
  dbMock.insert.mockResolvedValue(101);
  dbMock.query.mockResolvedValue([]);
});

describe('ServiceEndpoint — payload cannot choose its own owner', () => {
  it('ignores a citizenid supplied by the client on update', async () => {
    mount();

    await call('update', { id: 7, title: 'renamed', citizenid: 'CIT_VICTIM' });

    expect(dbMock.update.mock.calls[0][1]).toEqual(['renamed', 7, OWNER]);
    expect(sqlOf(dbMock.update.mock.calls[0])).toBe(
      "UPDATE `mica_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` NOT IN ('moderated', 'erased', 'expired')"
    );
  });

  it('ignores a citizenid supplied by the client on create', async () => {
    mount();

    await call('create', { title: 'mine', citizenid: 'CIT_VICTIM' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toBe('INSERT INTO `mica_test` (`title`, `citizenid`) VALUES (?, ?)');
    expect(params).toEqual(['mine', OWNER]);
  });

  it('scopes delete to the authenticated player', async () => {
    mount();

    await call('delete', { id: 9, citizenid: 'CIT_VICTIM' });

    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 9, OWNER]);
  });
});

describe('ServiceEndpoint — payload field allowlist', () => {
  it('drops unknown keys and status instead of forwarding them to SQL', async () => {
    mount();

    await call('update', {
      id: 7,
      title: 'renamed',
      status: 'active',
      evil: 'DROP TABLE',
      'title` = ?, `citizenid': 'x'
    });

    expect(sqlOf(dbMock.update.mock.calls[0])).toBe(
      "UPDATE `mica_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` NOT IN ('moderated', 'erased', 'expired')"
    );
    expect(dbMock.update.mock.calls[0][1]).toEqual(['renamed', 7, OWNER]);
  });

  it('refuses an update whose only fields are forbidden ones', async () => {
    mount();

    await call('update', { id: 7, citizenid: 'CIT_VICTIM', status: 'active' });

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(lastReply().error).toMatch(/No writable fields/);
  });

  it('refuses a create with nothing writable in it', async () => {
    mount();

    await call('create', { id: 3, status: 'active' });

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(lastReply().error).toMatch(/No writable fields/);
  });

  it('rejects a structured value where a scalar column is expected', async () => {
    mount();

    await call('update', { id: 7, title: { nested: 'object' } });

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(lastReply().error).toMatch(/must be a scalar value/);
  });

  it('passes through null so a column can be cleared', async () => {
    mount();

    await call('update', { id: 7, content: null });

    expect(dbMock.update.mock.calls[0][1]).toEqual([null, 7, OWNER]);
  });

  it('restricts read filters to the declared filterable set and forces the owner', async () => {
    mount();

    await call('get', { title: 'Groceries', citizenid: 'CIT_VICTIM', evil: 1 });

    expect(sqlOf(dbMock.query.mock.calls[0])).toBe(
      'SELECT * FROM `mica_test` WHERE `title` = ? AND `citizenid` = ? AND `status` = ?'
    );
    expect(dbMock.query.mock.calls[0][1]).toEqual(['Groceries', OWNER, 'active']);
  });

  it('handles a null payload on get without throwing', async () => {
    mount();

    await call('get', null);

    expect(dbMock.query.mock.calls[0][1]).toEqual([OWNER, 'active']);
  });
});

describe('ServiceEndpoint — row id validation', () => {
  it.each([
    ['a missing id', {}],
    ['a non-numeric id', { id: 'abc' }],
    ['a zero id', { id: 0 }],
    ['a negative id', { id: -3 }],
    ['a fractional id', { id: 1.5 }],
    // Number([7]) is 7, so a bare coercion would have accepted this.
    ['an array id', { id: [7] }],
    ['an object id', { id: { valueOf: 7 } }],
    ['a boolean id', { id: true }],
    ['a null payload', null]
  ])('rejects %s on update', async (_label, payload) => {
    mount();

    await call('update', payload);

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(lastReply().error).toMatch(/valid numeric id/);
  });

  it('rejects a bad id on delete before touching the database or the audit log', async () => {
    mount();

    await call('delete', { id: 'abc' });

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(auditMock.AuditLogger.log).not.toHaveBeenCalled();
    expect(lastReply().error).toMatch(/valid numeric id/);
  });
});

describe('ServiceEndpoint — responses and side effects', () => {
  it('stamps the fields MySQL owns so the client gets a well-formed row back', async () => {
    mount();

    await call('create', { title: 'mine' });

    const reply = lastReply();
    expect(reply).toMatchObject({ id: 101, title: 'mine', status: 'active' });
    // Stamped onto the row, never answered (MICA-433): the client knows who it is.
    expect(reply).not.toHaveProperty('citizenid');
    expect(typeof reply.created_at).toBe('string');
    expect(typeof reply.updated_at).toBe('string');
  });

  /**
   * MICA-433: the owner read is a `SELECT *`, so every row carried the caller's citizenid and
   * phone id to the client and, through `useService`, to any add-on. The reply leaves both out.
   */
  it("answers an owner read without the caller's citizenid or phone id", async () => {
    mount();
    dbMock.query.mockResolvedValueOnce([
      { id: 1, citizenid: OWNER, device_id: 'PHONE_1', title: 'mine' },
      { id: 2, citizenid: OWNER, device_id: 'PHONE_1', title: 'also mine' }
    ]);

    await call('get', {});

    // Still the owner's rows: the predicate names them, the reply does not.
    expect(sqlOf(dbMock.query.mock.calls[0])).toContain('`citizenid` = ?');
    expect(lastReply()).toEqual([
      { id: 1, title: 'mine' },
      { id: 2, title: 'also mine' }
    ]);
  });

  it('answers a paged owner read without them too, rows inside the envelope', async () => {
    mount({ paging: { pageSize: 1, maxPageSize: 5 } });
    dbMock.query.mockResolvedValueOnce([
      { id: 9, citizenid: OWNER, device_id: 'PHONE_1', title: 'newest' },
      { id: 8, citizenid: OWNER, device_id: 'PHONE_1', title: 'next' }
    ]);

    await call('get', {});

    expect(lastReply()).toEqual({ rows: [{ id: 9, title: 'newest' }], nextCursor: 9 });
  });

  it('does not let a client-sent timestamp reach the insert', async () => {
    mount();

    await call('create', { title: 'mine', created_at: '1999-01-01T00:00:00.000Z' });

    expect(String(dbMock.insert.mock.calls[0][0])).not.toContain('created_at');
  });

  it('writes an audit entry with the parsed id on a successful delete', async () => {
    mount();

    await call('delete', { id: 9 });

    expect(auditMock.AuditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        citizenid: OWNER,
        action: 'deleted',
        targetId: 9,
        targetTable: 'mica_test'
      })
    );
  });

  it('skips the audit entry when the delete matched no owned row', async () => {
    mount();
    dbMock.update.mockResolvedValue(false);

    await call('delete', { id: 9 });

    expect(auditMock.AuditLogger.log).not.toHaveBeenCalled();
    expect(lastReply()).toBe(false);
  });

  it('runs onAfterDelete with the parsed id only on success', async () => {
    const onAfterDelete = vi.fn().mockResolvedValue(undefined);
    mount({ onAfterDelete });

    await call('delete', { id: 9 });
    expect(onAfterDelete).toHaveBeenCalledWith(OWNER, 9);

    dbMock.update.mockResolvedValue(false);
    onAfterDelete.mockClear();
    await call('delete', { id: 10 });
    expect(onAfterDelete).not.toHaveBeenCalled();
  });
});

describe('ServiceEndpoint — authentication and registration', () => {
  it('rejects an unauthenticated caller before running any handler logic', async () => {
    mount();
    bridgeMock.FrameworkBridge.getPlayer.mockReturnValue(null);

    await call('update', { id: 7, title: 'renamed' });

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(lastReply()).toEqual({
      error: 'Player not authenticated',
      key: 'server.notAuthenticated'
    });
  });

  it('registers exactly the CRUD events that are not disabled', () => {
    mount({ disableUpdate: true, disableDelete: true });

    expect([...handlers.keys()].toSorted()).toEqual([
      'mica:server:test:create',
      'mica:server:test:get'
    ]);
  });

  it('maps each action onto its own client response event', async () => {
    mount();

    await call('get', null);
    expect(emitted[0][0]).toBe('mica:client:test:receive');

    await call('create', { title: 'a' });
    expect(emitted[1][0]).toBe('mica:client:test:created');

    await call('update', { id: 1, title: 'b' });
    expect(emitted[2][0]).toBe('mica:client:test:updated');

    await call('delete', { id: 1 });
    expect(emitted[3][0]).toBe('mica:client:test:deleted');
  });

  it('replies to the requesting source with the correlation id it was given', async () => {
    mount();

    await call('get', null);

    const [, src, cbId] = emitted[0];
    expect(src).toBe(5);
    expect(cbId).toBe('cb-1');
  });
});

/**
 * The contract boundary: what a custom action accepts, and what a caller is told when it does
 * not. `test_contract` rather than `test`, so the endpoints mounted above stay contract-free
 * and keep exercising the generic path.
 */
const boundaryContract = defineContract({
  id: 'test_contract',
  actions: {
    rename: { input: s.object({ id: s.positiveInt(), title: s.string({ max: 10 }) }) },
    refuse: { input: s.none() },
    burst: { input: s.none() }
  }
});

const mountContract = () => {
  handlers = new Map();
  emitted = [];

  (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
    handlers.set(event, cb);
  };
  (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
    emitted.push(args);
  };
  (globalThis as Record<string, unknown>).source = 5;

  return new ServiceEndpoint<TestRow, typeof boundaryContract>('test_contract', new TestRepo(), {
    contract: boundaryContract,
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  });
};

const callContract = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:test_contract:${action}`);
  if (!handler) throw new Error(`no handler registered for '${action}'`);
  await handler('cb-1', data);
};

describe('ServiceEndpoint — a custom action is validated by its contract', () => {
  it('parses the payload before the handler sees it', async () => {
    const app = mountContract();
    let seen: unknown;
    app.registerEvent('rename', async (_source, _cbId, data) => {
      seen = data;
      return true;
    });

    await callContract('rename', { id: '4', title: 'ok' });

    // Coerced by the schema, so the handler receives a number rather than the string the
    // payload carried — the coercion `requirePositiveInt` used to do in each handler.
    expect(seen).toEqual({ id: 4, title: 'ok' });
  });

  it('refuses a payload the schema does not accept, without running the handler', async () => {
    const app = mountContract();
    const ran = vi.fn();
    app.registerEvent('rename', async () => ran());

    await callContract('rename', { id: 4, title: 'far too long a title' });

    expect(lastReply().error).toContain('title');
    expect(ran).not.toHaveBeenCalled();
  });

  it('refuses at startup an action the contract does not declare', () => {
    const app = mountContract();

    expect(() =>
      // @ts-expect-error — the type refuses it first, which is the point; this proves the
      // runtime does too, for a build where the type error was ignored.
      app.registerEvent('undeclared', async () => true)
    ).toThrow(/does not declare/);
  });

  it('refuses at startup a custom action on a service with no contract at all', () => {
    const { app } = mount();

    expect(() => app.registerEvent('somethingCustom', async () => true)).toThrow(
      /without a contract/
    );
  });
});

/**
 * Which errors a player is allowed to read.
 *
 * Every throw used to leave through one line with its message intact, so a driver failure
 * carrying the statement text that failed reached a toast looking exactly like a deliberate
 * refusal. See `lib/errors.ts`.
 */
describe('ServiceEndpoint — what an error discloses', () => {
  it('forwards a PlayerFacingError, which is a refusal somebody wrote', async () => {
    const app = mountContract();
    app.registerEvent('refuse', async () => {
      throw new PlayerFacingError('You cannot do that yet.');
    });

    await callContract('refuse', undefined);

    expect(lastReply()).toEqual({ error: 'You cannot do that yet.' });
  });

  it('forwards the key and params a player-facing error carries (MICA-216)', async () => {
    const app = mountContract();
    app.registerEvent('refuse', async () => {
      throw new PlayerFacingError('No, Trevor.', {
        key: 'server.probe.refused',
        params: { name: 'Trevor' }
      });
    });

    await callContract('refuse', undefined);

    // The English rides with the key: a client whose catalog lacks the key shows it.
    expect(lastReply()).toEqual({
      error: 'No, Trevor.',
      key: 'server.probe.refused',
      params: { name: 'Trevor' }
    });
  });

  it('forwards a SchemaError, which names a field and nothing else', async () => {
    const app = mountContract();
    app.registerEvent('rename', async () => true);

    await callContract('rename', { id: 0, title: 'ok' });

    expect(lastReply().error).toContain('id');
    expect(lastReply().error).not.toBe(GENERIC_ERROR_MESSAGE);
  });

  it('replaces anything else with one generic sentence, and logs the stack', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = mountContract();
    app.registerEvent('refuse', async () => {
      throw new Error("ER_PARSE_ERROR: You have an error in your SQL syntax near 'SELECT'");
    });

    await callContract('refuse', undefined);

    // MICA-216: the generic sentence carries its own key so the shell can say it in the
    // player's language; a driver error never gets a key of its own, or it would be one.
    expect(lastReply()).toEqual({ error: GENERIC_ERROR_MESSAGE, key: 'server.generic' });
    // The whole error object, so the stack goes to the log rather than to the player.
    expect(logged).toHaveBeenCalled();
    expect(String(JSON.stringify(lastReply()))).not.toContain('SELECT');
    logged.mockRestore();
  });

  it('says nothing about the database when a repository invariant fires', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = mountContract();
    app.registerEvent('refuse', async () => {
      throw new Error("[Repository] update on 'mica_test' requires a citizenid.");
    });

    await callContract('refuse', undefined);

    expect(lastReply().error).not.toContain('mica_test');
    expect(lastReply().error).not.toContain('[Repository]');
    logged.mockRestore();
  });
});

/**
 * MICA-282: a device-owned service scopes every generic action by the caller's phone as well
 * as their citizenid, and hands the phone to every handler. The phone comes from the resolver
 * in `lib/deviceIdentity.ts` — `setup.ts` installs a stub answering `TEST_PHONE_ID` for every
 * suite — and never from the payload: `device_id` is on the blanket refusal lists (MICA-281).
 */
describe('ServiceEndpoint — a device-owned service follows the phone', () => {
  class DeviceRepo extends Repository<TestRow & { device_id: string }> {
    protected tableName = 'mica_device_test';
    protected columns = [
      'id',
      'citizenid',
      'device_id',
      'title',
      'content',
      'status',
      'created_at',
      'updated_at'
    ];
    protected clientWritable = ['title', 'content', 'device_id'];
    protected clientFilterable = ['title', 'device_id'];
  }

  const mountDevice = (options: ServiceOptions = {}) => {
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    return new ServiceEndpoint<TestRow>('test', new DeviceRepo() as any, {
      deviceOwned: true,
      ...options
    });
  };

  it('filters the generic read by the phone in hand, beside the citizen', async () => {
    mountDevice();

    await call('get', { title: 'x', device_id: 'SOMEBODY_ELSES' });

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('`citizenid` = ?');
    expect(String(sql)).toContain('`device_id` = ?');
    // The payload's phone id never reaches the statement; the resolver's does.
    expect(params).toEqual(['x', OWNER, TEST_PHONE_ID, 'active']);
  });

  it('stamps the phone on create, whatever the payload claimed', async () => {
    mountDevice();

    await call('create', { title: 'mine', device_id: 'SOMEBODY_ELSES' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toBe(
      'INSERT INTO `mica_device_test` (`title`, `citizenid`, `device_id`) VALUES (?, ?, ?)'
    );
    expect(params).toEqual(['mine', OWNER, TEST_PHONE_ID]);
  });

  it('narrows update and delete to the phone, never dropping the citizen', async () => {
    mountDevice();

    await call('update', { id: 7, title: 'renamed' });
    expect(sqlOf(dbMock.update.mock.calls[0])).toContain(
      'WHERE `id` = ? AND `citizenid` = ? AND `device_id` = ?'
    );
    expect(dbMock.update.mock.calls[0][1]).toEqual(['renamed', 7, OWNER, TEST_PHONE_ID]);

    await call('delete', { id: 9 });
    expect(dbMock.update.mock.calls[1][1]).toEqual(['deleted', 9, OWNER, TEST_PHONE_ID]);
  });

  it('hands a custom handler the phone as its sixth argument', async () => {
    const seen: unknown[] = [];
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    const app = new ServiceEndpoint<TestRow, typeof boundaryContract>(
      'test_contract',
      new DeviceRepo() as any,
      {
        deviceOwned: true,
        contract: boundaryContract,
        disableGet: true,
        disableCreate: true,
        disableUpdate: true,
        disableDelete: true
      }
    );
    app.registerEvent('refuse', async (_s, _cb, _d, citizenid, _player, deviceId) => {
      seen.push(citizenid, deviceId);
      return true;
    });

    await callContract('refuse', undefined);

    expect(seen).toEqual([OWNER, TEST_PHONE_ID]);
  });

  it('refuses the whole request, as a toast, when the player holds no phone', async () => {
    __setDeviceResolvers({
      forRequest: async () => {
        throw new PlayerFacingError('You are not holding a phone.', {
          key: 'server.phone.notHeld'
        });
      }
    });
    mountDevice();

    await call('get', {});

    expect(lastReply()).toEqual({
      error: 'You are not holding a phone.',
      key: 'server.phone.notHeld',
      params: undefined
    });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('does not ask which phone at all for a service that belongs to the citizen', async () => {
    let asked = 0;
    __setDeviceResolvers({
      forRequest: async () => {
        asked += 1;
        return TEST_PHONE_ID;
      }
    });
    mount();

    await call('get', {});

    expect(asked).toBe(0);
    expect(dbMock.query.mock.calls[0][1]).toEqual([OWNER, 'active']);
  });
});

/**
 * MICA-264: a request names the device it speaks for, as the event's third argument. Absent is
 * the phone; anything that is not a device is refused whole; a device the service does not
 * list is refused before the player is looked up; and a request from any device but the phone
 * is a claim to be holding one, which the check in `lib/deviceIdentity.ts` answers.
 */
describe('ServiceEndpoint — the device a request speaks for', () => {
  class DeviceRepo extends Repository<TestRow & { device_id: string }> {
    protected tableName = 'mica_device_test';
    protected columns = [
      'id',
      'citizenid',
      'device_id',
      'title',
      'content',
      'status',
      'created_at',
      'updated_at'
    ];
    protected clientWritable = ['title', 'content'];
    protected clientFilterable = ['title'];
  }

  const asked: {
    forRequest: unknown[][];
    options: (RequestDeviceOptions | undefined)[];
    deviceInHand: unknown[][];
  } = {
    forRequest: [],
    options: [],
    deviceInHand: []
  };

  /**
   * The stub's answers, with every question recorded. `refuse` makes the device check throw —
   * `deviceInHand`, and a resolve asked to be that check (`requireHeld`, MICA-362), as the real
   * resolver is.
   */
  const installRecording = (refuse?: PlayerFacingError) => {
    __setDeviceResolvers({
      forRequest: async (src, citizenid, device = 'phone', options) => {
        asked.forRequest.push([src, citizenid, device]);
        asked.options.push(options);
        if (refuse && options?.requireHeld) throw refuse;
        return device === 'tablet' ? TEST_TABLET_ID : TEST_PHONE_ID;
      },
      forCitizen: async () => TEST_PHONE_ID,
      deviceInHand: (player, device) => {
        asked.deviceInHand.push([player.citizenid, device]);
        if (refuse) throw refuse;
      }
    });
  };

  const mountWith = (options: ServiceOptions, deviceOwned = false) => {
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    return new ServiceEndpoint<TestRow>(
      'test',
      deviceOwned ? (new DeviceRepo() as any) : new TestRepo(),
      { ...(deviceOwned ? { deviceOwned: true } : {}), ...options }
    );
  };

  const callAs = async (action: string, data: unknown, ...device: unknown[]) => {
    const handler = handlers.get(`mica:server:test:${action}`);
    if (!handler) throw new Error(`no handler registered for '${action}'`);
    await (handler as (...args: unknown[]) => Promise<void>)('cb-1', data, ...device);
  };

  beforeEach(() => {
    asked.forRequest = [];
    asked.options = [];
    asked.deviceInHand = [];
    installRecording();
  });

  afterEach(() => {
    installTestPhone();
  });

  it('reads a request with no device as the phone, on the phone, with no device check', async () => {
    mountWith({}, true);

    await callAs('get', {});

    expect(asked.forRequest).toEqual([[5, OWNER, 'phone']]);
    // The endpoint's player is handed through (MICA-362), and the phone is not held to a check.
    expect(asked.options).toEqual([
      { player: expect.objectContaining({ citizenid: OWNER }), requireHeld: false }
    ]);
    expect(asked.deviceInHand).toEqual([]);
    expect(dbMock.query.mock.calls[0][1]).toEqual([OWNER, TEST_PHONE_ID, 'active']);
  });

  it("reads a request naming 'phone' exactly as one naming nothing", async () => {
    mountWith({}, true);

    await callAs('get', {}, 'phone');

    expect(asked.forRequest).toEqual([[5, OWNER, 'phone']]);
    expect(asked.deviceInHand).toEqual([]);
  });

  // Each wrapped, so `['tablet']` reaches the handler as an array rather than being spread.
  it.each(['watch', 'PHONE', '', 0, null, true, {}, ['tablet']].map((bad) => [bad]))(
    'refuses a device that is not one (%j) whole, before anything is read',
    async (bad: unknown) => {
      mountWith({ devices: ['phone', 'tablet'] }, true);

      await callAs('get', {}, bad);

      expect(lastReply()).toEqual({ error: GENERIC_ERROR_MESSAGE, key: 'server.generic' });
      expect(bridgeMock.FrameworkBridge.getPlayer).not.toHaveBeenCalled();
      expect(asked.forRequest).toEqual([]);
      expect(dbMock.query).not.toHaveBeenCalled();
    }
  );

  it('refuses a tablet request to a phone-only service, before the player is looked up', async () => {
    mountWith({}, true);

    await callAs('get', {}, 'tablet');

    expect(lastReply()).toEqual({
      error: 'test is not available on the tablet.',
      key: 'server.device.unsupported',
      params: { service: 'test', device: 'Tablet' }
    });
    expect(bridgeMock.FrameworkBridge.getPlayer).not.toHaveBeenCalled();
    expect(asked.forRequest).toEqual([]);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a phone request to a service that lists only the tablet', async () => {
    mountWith({ devices: ['tablet'] });

    await callAs('get', {});

    expect(lastReply()?.key).toBe('server.device.unsupported');
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a tablet request from a player holding no tablet, as a toast', async () => {
    installRecording(
      new PlayerFacingError('You are not holding a tablet.', {
        key: 'server.device.notHeld',
        params: { device: 'Tablet' }
      })
    );
    mountWith({ devices: ['phone', 'tablet'] }, true);

    await callAs('get', {}, 'tablet');

    expect(lastReply()).toEqual({
      error: 'You are not holding a tablet.',
      key: 'server.device.notHeld',
      params: { device: 'Tablet' }
    });
    // Refused by the resolve, which is the in-hand check on a device-owned service (MICA-362):
    // one slot read, not a count and then a read.
    expect(asked.deviceInHand).toEqual([]);
    expect(asked.forRequest).toEqual([[5, OWNER, 'tablet']]);
    expect(asked.options[0]?.requireHeld).toBe(true);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('checks the tablet is in hand on a service that is not device-owned too', async () => {
    installRecording(
      new PlayerFacingError('The tablet is turned off on this server.', {
        key: 'server.device.off',
        params: { device: 'Tablet' }
      })
    );
    mountWith({ devices: ['phone', 'tablet'] });

    await callAs('get', {}, 'tablet');

    expect(lastReply()?.key).toBe('server.device.off');
    expect(asked.deviceInHand).toEqual([[OWNER, 'tablet']]);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it("answers a held tablet from the tablet's own rows on a device-owned service", async () => {
    mountWith({ devices: ['phone', 'tablet'] }, true);

    await callAs('get', {}, 'tablet');

    expect(asked.deviceInHand).toEqual([]);
    expect(asked.forRequest).toEqual([[5, OWNER, 'tablet']]);
    expect(asked.options).toEqual([
      { player: expect.objectContaining({ citizenid: OWNER }), requireHeld: true }
    ]);
    expect(dbMock.query.mock.calls[0][1]).toEqual([OWNER, TEST_TABLET_ID, 'active']);
  });

  it("answers a held tablet from the citizen's rows on a service that is not device-owned", async () => {
    mountWith({ devices: ['phone', 'tablet'] });

    await callAs('get', {}, 'tablet');

    expect(asked.forRequest).toEqual([]);
    expect(dbMock.query.mock.calls[0][1]).toEqual([OWNER, 'active']);
  });

  it('refuses a tablet request whole when no device check is installed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setDeviceResolvers({ forRequest: async () => TEST_PHONE_ID });
    mountWith({ devices: ['phone', 'tablet'] });

    await callAs('get', {}, 'tablet');

    expect(lastReply()?.error).toBe(GENERIC_ERROR_MESSAGE);
    expect(dbMock.query).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

/**
 * MICA-339 F19: what moves money or publishes needs a phone in hand, server-side, even on a
 * service that is not `deviceOwned`. Reads stay open, so the shell's boot calls and every
 * badge preload still answer a player who holds none.
 */
describe('ServiceEndpoint — an action flagged requirePhoneFor needs a phone in hand', () => {
  const phoneContract = defineContract({
    id: 'test_phone_contract',
    actions: {
      send: { input: s.object({ body: s.string({ max: 20 }) }) },
      list: { input: s.none() }
    }
  });

  const holds = { phone: true };
  const asked: string[] = [];
  const sent = vi.fn(async () => ({ ok: true }));
  const listed = vi.fn(async () => []);

  const mountFlagged = () => {
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    const app = new ServiceEndpoint<TestRow, typeof phoneContract>('test', null, {
      contract: phoneContract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    app.registerEvent('send', sent);
    app.registerEvent('list', listed);
    app.requirePhoneFor('send');
  };

  beforeEach(() => {
    holds.phone = true;
    asked.length = 0;
    __setDeviceResolvers({
      forRequest: async () => TEST_PHONE_ID,
      forCitizen: async () => TEST_PHONE_ID,
      deviceInHand: (_player, device) => {
        asked.push(device);
        if (device === 'phone' && !holds.phone) {
          throw new PlayerFacingError('You are not holding a phone.', {
            key: 'server.phone.notHeld'
          });
        }
      }
    });
    mountFlagged();
  });

  afterEach(() => {
    installTestPhone();
  });

  it('refuses a flagged action to a player holding no phone, with the notHeld key', async () => {
    holds.phone = false;

    await call('send', { body: 'hi' });

    expect(sent).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({ key: 'server.phone.notHeld' });
    expect(asked).toEqual(['phone']);
  });

  it('runs a flagged action for a player who holds one', async () => {
    await call('send', { body: 'hi' });

    expect(sent).toHaveBeenCalledOnce();
    expect(lastReply()).toEqual({ ok: true });
  });

  it('leaves an unflagged read alone, phone or not, and never counts the inventory', async () => {
    holds.phone = false;

    await call('list', undefined);

    expect(listed).toHaveBeenCalledOnce();
    expect(lastReply()).toEqual([]);
    expect(asked).toEqual([]);
  });
});

/**
 * MICA-362: an action handed the device in hand on a service that is not `deviceOwned`
 * (`resolveDeviceFor`, as Messages' `send` is). The resolve gets the endpoint's own player, and
 * an action also flagged `requirePhoneFor` is held to the in-hand check by that same resolve —
 * one slot read for both questions, never a count beside it.
 */
describe('ServiceEndpoint — an action resolved at the endpoint asks the inventory once', () => {
  const resolvedContract = defineContract({
    id: 'test_resolved_contract',
    actions: {
      send: { input: s.object({ body: s.string({ max: 20 }) }) },
      list: { input: s.none() },
      ping: { input: s.none() }
    }
  });

  const holds = { phone: true };
  const asked: { forRequest: (RequestDeviceOptions | undefined)[]; deviceInHand: string[] } = {
    forRequest: [],
    deviceInHand: []
  };
  const seen: unknown[] = [];
  const record = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      seen.push([name, args[5]]);
      return true;
    });

  const mountResolved = () => {
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    const app = new ServiceEndpoint<TestRow, typeof resolvedContract>('test', null, {
      contract: resolvedContract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    app.registerEvent('send', record('send'));
    app.registerEvent('list', record('list'));
    app.registerEvent('ping', record('ping'));
    app.requirePhoneFor('send').resolveDeviceFor('send', 'list');
  };

  beforeEach(() => {
    holds.phone = true;
    asked.forRequest = [];
    asked.deviceInHand = [];
    seen.length = 0;
    __setDeviceResolvers({
      // The real resolver's contract: `requireHeld` refuses a player holding none.
      forRequest: async (_src, _citizenid, _device, options) => {
        asked.forRequest.push(options);
        if (options?.requireHeld && !holds.phone) {
          throw new PlayerFacingError('You are not holding a phone.', {
            key: 'server.phone.notHeld'
          });
        }
        return TEST_PHONE_ID;
      },
      forCitizen: async () => TEST_PHONE_ID,
      deviceInHand: (_player, device) => {
        asked.deviceInHand.push(device);
      }
    });
    mountResolved();
  });

  afterEach(() => {
    installTestPhone();
  });

  it('resolves a flagged action once, as the in-hand check, with the player it looked up', async () => {
    await call('send', { body: 'hi' });

    expect(lastReply()).toBe(true);
    expect(seen).toEqual([['send', TEST_PHONE_ID]]);
    expect(asked.deviceInHand).toEqual([]);
    expect(asked.forRequest).toHaveLength(1);
    expect(asked.forRequest[0]?.requireHeld).toBe(true);
    // The very object the endpoint looked up: no second walk of the framework's players.
    expect(asked.forRequest[0]?.player).toBe(
      bridgeMock.FrameworkBridge.getPlayer.mock.results[0].value
    );
    expect(bridgeMock.FrameworkBridge.getPlayer).toHaveBeenCalledOnce();
  });

  it('refuses a flagged action to a player holding no phone, from that one resolve', async () => {
    holds.phone = false;

    await call('send', { body: 'hi' });

    expect(seen).toEqual([]);
    expect(lastReply()).toMatchObject({ key: 'server.phone.notHeld' });
    expect(asked.deviceInHand).toEqual([]);
    expect(asked.forRequest).toHaveLength(1);
  });

  it('resolves an unflagged action without holding it to the check', async () => {
    holds.phone = false;

    await call('list', undefined);

    expect(seen).toEqual([['list', TEST_PHONE_ID]]);
    expect(asked.forRequest[0]?.requireHeld).toBe(false);
    expect(asked.deviceInHand).toEqual([]);
  });

  it('asks nothing about the device for an action it was not told to resolve', async () => {
    await call('ping', undefined);

    expect(seen).toEqual([['ping', undefined]]);
    expect(asked.forRequest).toEqual([]);
    expect(asked.deviceInHand).toEqual([]);
  });

  it('reads the slots again on every request, so a phone taken in between is refused', async () => {
    await call('send', { body: 'hi' });
    holds.phone = false;
    await call('send', { body: 'again' });

    expect(seen).toEqual([['send', TEST_PHONE_ID]]);
    expect(lastReply()).toMatchObject({ key: 'server.phone.notHeld' });
    expect(asked.forRequest).toHaveLength(2);
  });
});

/**
 * MICA-362 review: an add-on's contract may carry a foreign Standard Schema whose `validate`
 * awaits, and a character switch keeps the source. The player looked up before such a check is
 * not handed to the resolve unasked: the source is looked up again, and a request whose source
 * is now another character is refused whole rather than resolved — the inventory keyed by the
 * source would name the new character's phone, and the resolve would hand it to the old one.
 */
describe('ServiceEndpoint — a schema that awaits does not hand a stale player to the resolve', () => {
  const SWITCHED = 'CIT_SWITCHED';
  /** What the foreign schema does while the endpoint awaits it. */
  const during = { switchCharacter: false };
  const foreign = {
    '~standard': {
      version: 1 as const,
      vendor: 'foreign',
      validate: async (value: unknown) => {
        await Promise.resolve();
        if (during.switchCharacter) {
          bridgeMock.FrameworkBridge.getPlayer.mockReturnValue({ citizenid: SWITCHED, source: 5 });
        }
        return { value };
      }
    }
  };
  const foreignContract = defineContract({
    id: 'test_foreign_contract',
    actions: { send: { input: foreign } }
  });

  const options: (RequestDeviceOptions | undefined)[] = [];
  const seen: unknown[][] = [];

  beforeEach(() => {
    during.switchCharacter = false;
    options.length = 0;
    seen.length = 0;
    __setDeviceResolvers({
      forRequest: async (_src, _citizenid, _device, opts) => {
        options.push(opts);
        return TEST_PHONE_ID;
      },
      forCitizen: async () => TEST_PHONE_ID,
      deviceInHand: () => undefined
    });
    handlers = new Map();
    emitted = [];
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: Handler) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = (...args: unknown[]) => {
      emitted.push(args);
    };
    (globalThis as Record<string, unknown>).source = 5;
    const app = new ServiceEndpoint<TestRow, typeof foreignContract>('test', null, {
      contract: foreignContract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    app.registerEvent('send', async (...args: unknown[]) => {
      seen.push([args[3], (args[4] as { citizenid: string }).citizenid, args[5]]);
      return true;
    });
    app.requirePhoneFor('send').resolveDeviceFor('send');
  });

  afterEach(() => {
    installTestPhone();
  });

  it('refuses a request whose character switched during the check, resolving nothing', async () => {
    during.switchCharacter = true;

    await call('send', { body: 'hi' });

    expect(options).toEqual([]);
    expect(seen).toEqual([]);
    expect(lastReply()).toEqual({ error: GENERIC_ERROR_MESSAGE, key: 'server.generic' });
  });

  it('asks the source again after a check that awaited, and resolves with that answer', async () => {
    await call('send', { body: 'hi' });

    expect(bridgeMock.FrameworkBridge.getPlayer).toHaveBeenCalledTimes(2);
    expect(options).toHaveLength(1);
    expect(options[0]?.player).toBe(bridgeMock.FrameworkBridge.getPlayer.mock.results[1].value);
    expect(options[0]?.requireHeld).toBe(true);
    expect(seen).toEqual([[OWNER, OWNER, TEST_PHONE_ID]]);
    expect(lastReply()).toBe(true);
  });
});
