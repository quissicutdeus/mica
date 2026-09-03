// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { defineContract } from '@gos/shared/contract';
import { s } from '@gos/shared/schema';

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
  protected tableName = 'gos_test';
  protected columns = ['id', 'citizenid', 'title', 'content', 'status', 'created_at', 'updated_at'];
  protected clientWritable = ['title', 'content'];
  protected clientFilterable = ['title'];
}

const OWNER = 'CIT_OWNER';

type Handler = (cbId: string, data: unknown) => Promise<void>;

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
  const handler = handlers.get(`gos:server:test:${action}`);
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
      "UPDATE `gos_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
    );
  });

  it('ignores a citizenid supplied by the client on create', async () => {
    mount();

    await call('create', { title: 'mine', citizenid: 'CIT_VICTIM' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toBe('INSERT INTO `gos_test` (`title`, `citizenid`) VALUES (?, ?)');
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
      "UPDATE `gos_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
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
      'SELECT * FROM `gos_test` WHERE `title` = ? AND `citizenid` = ? AND `status` = ?'
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
    expect(reply).toMatchObject({ id: 101, title: 'mine', citizenid: OWNER, status: 'active' });
    expect(typeof reply.created_at).toBe('string');
    expect(typeof reply.updated_at).toBe('string');
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
        targetTable: 'gos_test'
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
      'gos:server:test:create',
      'gos:server:test:get'
    ]);
  });

  it('maps each action onto its own client response event', async () => {
    mount();

    await call('get', null);
    expect(emitted[0][0]).toBe('gos:client:test:receive');

    await call('create', { title: 'a' });
    expect(emitted[1][0]).toBe('gos:client:test:created');

    await call('update', { id: 1, title: 'b' });
    expect(emitted[2][0]).toBe('gos:client:test:updated');

    await call('delete', { id: 1 });
    expect(emitted[3][0]).toBe('gos:client:test:deleted');
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
  const handler = handlers.get(`gos:server:test_contract:${action}`);
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
      throw new Error("[Repository] update on 'gos_test' requires a citizenid.");
    });

    await callContract('refuse', undefined);

    expect(lastReply().error).not.toContain('gos_test');
    expect(lastReply().error).not.toContain('[Repository]');
    logged.mockRestore();
  });
});
