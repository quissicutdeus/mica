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
  protected tableName = 'gphone_test';
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
  const handler = handlers.get(`gphone:server:test:${action}`);
  if (!handler) throw new Error(`no handler registered for '${action}'`);
  await handler('cb-1', data);
};

/** The payload the last emitNet delivered back to the client. */
const lastReply = () => emitted[emitted.length - 1]?.[3] as any;
const sqlOf = (call: unknown[] | undefined) => String(call?.[0]).replace(/\s+/g, ' ').trim();

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
      "UPDATE `gphone_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
    );
  });

  it('ignores a citizenid supplied by the client on create', async () => {
    mount();

    await call('create', { title: 'mine', citizenid: 'CIT_VICTIM' });

    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toBe('INSERT INTO `gphone_test` (`title`, `citizenid`) VALUES (?, ?)');
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
      "UPDATE `gphone_test` SET `title` = ? WHERE `id` = ? AND `citizenid` = ? AND `status` != 'moderated'"
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
      'SELECT * FROM `gphone_test` WHERE `title` = ? AND `citizenid` = ? AND `status` = ?'
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
        targetTable: 'gphone_test'
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
    expect(lastReply()).toEqual({ error: 'Player not authenticated' });
  });

  it('registers exactly the CRUD events that are not disabled', () => {
    mount({ disableUpdate: true, disableDelete: true });

    expect([...handlers.keys()].sort()).toEqual([
      'gphone:server:test:create',
      'gphone:server:test:get'
    ]);
  });

  it('maps each action onto its own client response event', async () => {
    mount();

    await call('get', null);
    expect(emitted[0][0]).toBe('gphone:client:test:receive');

    await call('create', { title: 'a' });
    expect(emitted[1][0]).toBe('gphone:client:test:created');

    await call('update', { id: 1, title: 'b' });
    expect(emitted[2][0]).toBe('gphone:client:test:updated');

    await call('delete', { id: 1 });
    expect(emitted[3][0]).toBe('gphone:client:test:deleted');
  });

  it('replies to the requesting source with the correlation id it was given', async () => {
    mount();

    await call('get', null);

    const [, src, cbId] = emitted[0];
    expect(src).toBe(5);
    expect(cbId).toBe('cb-1');
  });
});
