import { describe, it, expect, vi } from 'vitest';

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

import {
  resolveAppSchema,
  buildRepository,
  defineServerApp,
  declaredApps,
  type ServerAppDefinition
} from '../lib/defineServerApp';
import { toCreateTableSql, toSqlFile } from '../lib/schemaSql';

const notesDefinition: ServerAppDefinition = {
  id: 'notes',
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    title: { type: 'string', length: 255 },
    content: 'text'
  }
};

describe('resolveAppSchema — derived lists', () => {
  it('prepends the framework-supplied columns in table order', () => {
    expect(resolveAppSchema(notesDefinition).columns).toEqual([
      'id',
      'citizenid',
      'status',
      'created_at',
      'updated_at',
      'title',
      'content'
    ]);
  });

  it('defaults the table name to gphone_<id>', () => {
    expect(resolveAppSchema(notesDefinition).table).toBe('gphone_notes');
    expect(resolveAppSchema({ ...notesDefinition, table: 'custom' }).table).toBe('custom');
  });

  it('treats declared fields as client-writable and framework columns as not', () => {
    const resolved = resolveAppSchema(notesDefinition);

    expect(resolved.clientWritable).toEqual(['title', 'content']);
    for (const framework of ['id', 'citizenid', 'status', 'created_at', 'updated_at']) {
      expect(resolved.clientWritable).not.toContain(framework);
    }
  });

  it('lets a field opt out of client writes', () => {
    const resolved = resolveAppSchema({
      id: 'ledger',
      schema: { label: 'string', balance: { type: 'int', clientWritable: false } }
    });

    expect(resolved.clientWritable).toEqual(['label']);
    expect(resolved.columns).toContain('balance');
  });

  it('keeps filterable opt-in, and never filterable-but-not-writable', () => {
    const resolved = resolveAppSchema({
      id: 'x',
      schema: {
        phone: { type: 'string', clientFilterable: true },
        note: 'text',
        secret: { type: 'string', clientWritable: false, clientFilterable: true }
      }
    });

    expect(resolved.clientFilterable).toEqual(['phone']);
  });

  it('shuts the generic write path for shared-scope apps', () => {
    // Rows several players can see cannot be authorized by ownership, so nothing is
    // client-writable through the generic path — membership checks must be explicit.
    const resolved = resolveAppSchema({
      id: 'conversations',
      scope: 'shared',
      schema: { name: 'string' }
    });

    expect(resolved.clientWritable).toEqual([]);
    expect(resolved.clientFilterable).toEqual([]);
  });
});

describe('resolveAppSchema — rejections', () => {
  it('refuses a schema that redeclares a framework column', () => {
    expect(() =>
      resolveAppSchema({ id: 'x', schema: { citizenid: 'string', title: 'string' } })
    ).toThrow(/supplied by the framework/);
  });

  it('refuses a field name that is not a safe SQL identifier', () => {
    for (const bad of ['Title', 'my-field', '1st', 'drop table', '']) {
      expect(() => resolveAppSchema({ id: 'x', schema: { [bad]: 'string' } })).toThrow(
        /lower_snake_case/
      );
    }
  });

  it('refuses an empty schema and a missing id', () => {
    expect(() => resolveAppSchema({ id: 'x', schema: {} })).toThrow(/at least one field/);
    expect(() => resolveAppSchema({ id: '', schema: { a: 'string' } })).toThrow(/'id' is required/);
  });

  it('refuses statuses missing active or deleted', () => {
    expect(() =>
      resolveAppSchema({ id: 'x', statuses: ['live', 'gone'], schema: { a: 'string' } })
    ).toThrow(/must include both 'active' and 'deleted'/);
  });
});

describe('buildRepository — inherits every Phase 1 guarantee', () => {
  it('rejects an undeclared column, so the allowlist still guards SQL identifiers', async () => {
    const repo = buildRepository(resolveAppSchema(notesDefinition));

    await expect(repo.create({ evil: 1 } as any)).rejects.toThrow(/rejected unknown column 'evil'/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('scopes update by citizenid', async () => {
    const repo = buildRepository(resolveAppSchema(notesDefinition));
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await repo.update(7, { title: 'x' } as any, 'CIT_OWNER');

    expect(String(dbMock.update.mock.calls[0][0])).toContain('`citizenid` = ?');
    expect(dbMock.update.mock.calls[0][1]).toEqual(['x', 7, 'CIT_OWNER']);
  });
});

describe('defineServerApp — event registration', () => {
  /** Capture the events ServerApp registers, so the wiring is observable. */
  const mountAndCapture = (definition: ServerAppDefinition): string[] => {
    const registered: string[] = [];
    (globalThis as Record<string, unknown>).onNet = (event: string) => {
      registered.push(event);
    };
    defineServerApp(definition);
    return registered;
  };

  it('registers the four generic CRUD events for an owner-scoped app', () => {
    const events = mountAndCapture({ id: 'owned_a', schema: { label: 'string' } });

    expect(events.sort()).toEqual([
      'gphone:server:owned_a:create',
      'gphone:server:owned_a:delete',
      'gphone:server:owned_a:get',
      'gphone:server:owned_a:update'
    ]);
  });

  it('registers only get for a shared-scope app', () => {
    // The important half of "shared scope": not just an empty clientWritable, but no
    // generic mutation endpoint existing at all. A membership check cannot be
    // expressed by ownership, so create/update/delete must be written by hand.
    const events = mountAndCapture({
      id: 'shared_a',
      scope: 'shared',
      schema: { label: 'string' }
    });

    expect(events).toEqual(['gphone:server:shared_a:get']);
  });

  it('lets an explicit option override the scope default', () => {
    const events = mountAndCapture({
      id: 'owned_b',
      schema: { label: 'string' },
      options: { disableUpdate: true, disableDelete: true }
    });

    expect(events.sort()).toEqual(['gphone:server:owned_b:create', 'gphone:server:owned_b:get']);
  });

  it('audits a delete against the declared table, not the id-derived default', async () => {
    // ServerApp defaults targetTable to `gphone_<appName>`. An app with a custom table
    // would otherwise log deletions against a table that does not exist.
    const handlers = new Map<string, (cbId: string, data: unknown) => Promise<void>>();
    (globalThis as Record<string, unknown>).onNet = (event: string, cb: any) => {
      handlers.set(event, cb);
    };
    (globalThis as Record<string, unknown>).emitNet = () => {};
    (globalThis as Record<string, unknown>).source = 5;

    bridgeMock.FrameworkBridge.getPlayer.mockReturnValue({ citizenid: 'CIT_A', source: 5 });
    dbMock.update.mockResolvedValue(true);
    auditMock.AuditLogger.log.mockClear();

    defineServerApp({ id: 'owned_d', table: 'legacy_table', schema: { label: 'string' } });
    await handlers.get('gphone:server:owned_d:delete')!('cb-1', { id: 3 });

    expect(auditMock.AuditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: 'legacy_table', targetId: 3, citizenid: 'CIT_A' })
    );
  });

  it('records every declaration in the registry that drives codegen', () => {
    const before = declaredApps.length;
    defineServerApp({ id: 'owned_e', schema: { label: 'string' } });

    expect(declaredApps.length).toBe(before + 1);
    expect(declaredApps.at(-1)?.id).toBe('owned_e');
  });

  it('refuses two apps declaring the same table', () => {
    defineServerApp({ id: 'first_owner', table: 'gphone_contested', schema: { a: 'string' } });

    expect(() =>
      defineServerApp({ id: 'second_owner', table: 'gphone_contested', schema: { b: 'string' } })
    ).toThrow(/already declared by another app/);
  });
});

describe('toSqlFile', () => {
  it('marks the output generated so nobody hand-edits it', () => {
    const file = toSqlFile(resolveAppSchema(notesDefinition));

    expect(file).toContain("-- Generated from the 'notes' defineServerApp declaration.");
    expect(file).toContain('Do not edit by hand');
    expect(file).toContain('CREATE TABLE IF NOT EXISTS `gphone_notes`');
  });
});

describe('toCreateTableSql', () => {
  const sql = toCreateTableSql(resolveAppSchema(notesDefinition));

  it('reproduces the shape of the hand-written gphone_notes table', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `gphone_notes`');
    expect(sql).toContain('`id` int(11) NOT NULL AUTO_INCREMENT');
    expect(sql).toContain('`citizenid` varchar(50) NOT NULL');
    expect(sql).toContain('`title` varchar(255) DEFAULT NULL');
    expect(sql).toContain('`content` text DEFAULT NULL');
    expect(sql).toContain("ENUM('active', 'archived', 'deleted', 'moderated')");
    expect(sql).toContain('`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain('ON UPDATE CURRENT_TIMESTAMP');
    expect(sql).toContain('PRIMARY KEY (`id`)');
    expect(sql).toContain('KEY `citizenid_status` (`citizenid`, `status`)');
    expect(sql).toContain('FOREIGN KEY (`citizenid`)');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('ENGINE = InnoDB');
  });

  it('emits no runtime DDL path — the string is all it produces', () => {
    expect(dbMock.query).not.toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE'));
  });

  it('emits composite indexes, which a per-column flag cannot express', () => {
    const out = toCreateTableSql(
      resolveAppSchema({
        ...notesDefinition,
        indexes: [['citizenid', 'status', 'updated_at']]
      })
    );

    expect(out).toContain(
      'KEY `citizenid_status_updated_at` (`citizenid`, `status`, `updated_at`)'
    );
  });

  it('rejects an index naming a column that does not exist', () => {
    expect(() =>
      resolveAppSchema({ ...notesDefinition, indexes: [['citizenid', 'nope']] })
    ).toThrow(/index references 'nope'/);
    expect(() => resolveAppSchema({ ...notesDefinition, indexes: [[]] })).toThrow(
      /at least one column/
    );
  });

  it('honours notNull, length and index', () => {
    const out = toCreateTableSql(
      resolveAppSchema({
        id: 'x',
        schema: {
          phone: { type: 'string', length: 20, notNull: true, index: true },
          avatar: 'blob',
          payload: 'json'
        }
      })
    );

    expect(out).toContain('`phone` varchar(20) NOT NULL');
    expect(out).toContain('KEY `citizenid_phone` (`citizenid`, `phone`)');
    expect(out).toContain('`avatar` mediumblob DEFAULT NULL');
    expect(out).toContain('`payload` longtext DEFAULT NULL');
  });

  it.each([
    ['string', 'string', 'varchar(255)'],
    ['text', 'text', 'text'],
    ['mediumtext', 'mediumtext', 'mediumtext'],
    ['int', 'int', 'int(11)'],
    ['bool', 'bool', 'tinyint(1)'],
    ['json', 'json', 'longtext'],
    ['blob', 'blob', 'mediumblob']
  ])('maps the %s column type to %s -> %s', (_label, type, expected) => {
    const out = toCreateTableSql(resolveAppSchema({ id: 'types', schema: { field: type as any } }));

    expect(out).toContain(`\`field\` ${expected} DEFAULT NULL`);
  });
});
