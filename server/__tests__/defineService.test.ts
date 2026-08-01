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
  defineService,
  declaredServices,
  SchemaRepository,
  type ServiceDefinition
} from '../lib/defineService';
import { toCreateTableSql, toChildTableSql, toSqlFile } from '../lib/schemaSql';

const notesDefinition: ServiceDefinition = {
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

  it('makes nothing client-writable for a server-authored app', () => {
    // Mail: rows arrive from jobs and dispatches, never from the phone's owner. The
    // row still belongs to one citizenid, so this is distinct from shared scope.
    const resolved = resolveAppSchema({
      id: 'mail',
      serverAuthored: true,
      schema: { sender: 'string', subject: { type: 'string', clientFilterable: true } }
    });

    expect(resolved.clientWritable).toEqual([]);
    expect(resolved.clientFilterable).toEqual([]);
    expect(resolved.scope).toBe('owner');
    expect(resolved.columns).toContain('sender');
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

describe('defineService — event registration', () => {
  /** Capture the events ServiceEndpoint registers, so the wiring is observable. */
  const mountAndCapture = (definition: ServiceDefinition): string[] => {
    const registered: string[] = [];
    (globalThis as Record<string, unknown>).onNet = (event: string) => {
      registered.push(event);
    };
    defineService(definition);
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

  it('registers get and delete but not create or update when server-authored', () => {
    // A server-authored row still belongs to one citizenid, so reading and deleting
    // your own mail is legitimate. Only authoring is closed.
    const events = mountAndCapture({
      id: 'authored_a',
      serverAuthored: true,
      schema: { sender: 'string' }
    });

    expect(events.sort()).toEqual([
      'gphone:server:authored_a:delete',
      'gphone:server:authored_a:get'
    ]);
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
    // ServiceEndpoint defaults targetTable to `gphone_<appName>`. An app with a custom table
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

    defineService({ id: 'owned_d', table: 'legacy_table', schema: { label: 'string' } });
    await handlers.get('gphone:server:owned_d:delete')!('cb-1', { id: 3 });

    expect(auditMock.AuditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: 'legacy_table', targetId: 3, citizenid: 'CIT_A' })
    );
  });

  it('records every declaration in the registry that drives codegen', () => {
    const before = declaredServices.length;
    defineService({ id: 'owned_e', schema: { label: 'string' } });

    expect(declaredServices.length).toBe(before + 1);
    expect(declaredServices.at(-1)?.id).toBe('owned_e');
  });

  it('refuses two apps declaring the same table', () => {
    defineService({ id: 'first_owner', table: 'gphone_contested', schema: { a: 'string' } });

    expect(() =>
      defineService({ id: 'second_owner', table: 'gphone_contested', schema: { b: 'string' } })
    ).toThrow(/already declared by another app/);
  });
});

describe('defineService — repositoryFactory', () => {
  it('lets an app subclass the derived repository for custom read shaping', async () => {
    (globalThis as Record<string, unknown>).onNet = () => {};
    dbMock.query.mockResolvedValue([{ id: 1, blobbed: Buffer.from('hello', 'utf8') }]);

    const { repo } = defineService<any>({
      id: 'shaped',
      schema: { blobbed: 'blob' },
      repositoryFactory: (resolved) =>
        new (class extends SchemaRepository<any> {
          async findAll(where: any = {}) {
            const rows = await super.findAll(where);
            return rows.map((row: any) => ({ ...row, blobbed: String(row.blobbed) }));
          }
        })(resolved)
    });

    const rows = (await repo.findAll({} as any)) as any[];
    expect(rows[0].blobbed).toBe('hello');
  });

  it('keeps the allowlist and ownership scoping through the subclass', async () => {
    (globalThis as Record<string, unknown>).onNet = () => {};
    dbMock.update.mockResolvedValue(true);

    const { repo } = defineService<any>({
      id: 'shaped_two',
      schema: { label: 'string' },
      repositoryFactory: (resolved) => new (class extends SchemaRepository<any> {})(resolved)
    });

    // Subclassing must not become a way around §2.9.
    await expect(repo.create({ evil: 1 } as any)).rejects.toThrow(/rejected unknown column/);

    dbMock.update.mockClear();
    await repo.update(3, { label: 'x' } as any, 'CIT_A');
    expect(String(dbMock.update.mock.calls[0][0])).toContain('`citizenid` = ?');
  });
});

describe('child tables', () => {
  const messagesish = {
    id: 'threads',
    schema: { body: 'text' },
    childTables: [
      {
        name: 'thread_attachments',
        columns: {
          message_id: {
            type: 'int' as const,
            notNull: true,
            references: { table: 'gphone_messages', column: 'id' }
          },
          kind: { type: 'enum' as const, values: ['photo', 'file'], notNull: true },
          seen_at: { type: 'timestamp' as const },
          touched_at: {
            type: 'timestamp' as const,
            notNull: true,
            defaultNow: true,
            onUpdateNow: true
          }
        },
        indexes: [['message_id']]
      }
    ]
  };

  it('emits the child table after the primary one, so foreign keys resolve', () => {
    const file = toSqlFile(resolveAppSchema(messagesish));

    expect(file.indexOf('`gphone_threads`')).toBeLessThan(file.indexOf('`thread_attachments`'));
  });

  it('gives a child table no implicit status or citizenid', () => {
    // The whole reason child tables exist: these tables disagree about whether they
    // carry the framework columns at all.
    const sql = toChildTableSql(messagesish.childTables[0]);

    expect(sql).not.toContain('`status` ENUM');
    expect(sql).not.toContain('`citizenid`');
    expect(sql).toContain('`id` int(11) NOT NULL AUTO_INCREMENT');
    expect(sql).toContain('PRIMARY KEY (`id`)');
  });

  it('can omit the auto-increment id entirely', () => {
    const sql = toChildTableSql({
      name: 'plain',
      autoIncrementId: false,
      columns: { label: 'string' }
    });

    expect(sql).not.toContain('AUTO_INCREMENT');
    expect(sql).not.toContain('PRIMARY KEY');
    expect(sql).toContain('`label` varchar(255) DEFAULT NULL');
  });

  it('emits a foreign key onto an arbitrary table', () => {
    const sql = toChildTableSql(messagesish.childTables[0]);

    expect(sql).toContain(
      'CONSTRAINT `fk_thread_attachments_message_id` FOREIGN KEY (`message_id`)'
    );
    expect(sql).toContain('REFERENCES `gphone_messages` (`id`) ON DELETE CASCADE');
  });

  it('honours a non-cascading onDelete', () => {
    const sql = toChildTableSql({
      name: 'soft',
      columns: {
        owner: {
          type: 'string' as const,
          references: { table: 'players', column: 'citizenid', onDelete: 'SET NULL' as const }
        }
      }
    });

    expect(sql).toContain('ON DELETE SET NULL');
  });

  it('closes the statement without a trailing comma', () => {
    const sql = toChildTableSql(messagesish.childTables[0]);
    expect(sql).not.toMatch(/,\s*\)\s*ENGINE/);
  });

  it.each([
    ['a name that is not lower_snake_case', { name: 'BadName', columns: { a: 'string' as const } }],
    ['no columns', { name: 'empty', columns: {} }],
    [
      'a column name that is not a safe identifier',
      { name: 'ok', columns: { 'DROP TABLE': 'string' as const } }
    ]
  ])('rejects a child table with %s', (_label, child) => {
    expect(() =>
      resolveAppSchema({ id: 'x', schema: { a: 'string' }, childTables: [child as any] })
    ).toThrow();
  });

  it('rejects a child table that collides with the primary table', () => {
    expect(() =>
      resolveAppSchema({
        id: 'x',
        schema: { a: 'string' },
        childTables: [{ name: 'gphone_x', columns: { b: 'string' } }]
      })
    ).toThrow(/collides with the primary table/);
  });
});

describe('timestamp and enum columns', () => {
  it('emits ON UPDATE CURRENT_TIMESTAMP only when asked', () => {
    const withOnUpdate = toChildTableSql({
      name: 't1',
      columns: { at: { type: 'timestamp', notNull: true, defaultNow: true, onUpdateNow: true } }
    });
    const without = toChildTableSql({
      name: 't2',
      columns: { at: { type: 'timestamp', notNull: true, defaultNow: true } }
    });

    // Omitting this on an updated_at column silently produces a table whose
    // timestamp never moves.
    expect(withOnUpdate).toContain('DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    expect(without).toContain('DEFAULT CURRENT_TIMESTAMP');
    expect(without).not.toContain('ON UPDATE');
  });

  it('renders a nullable timestamp as DEFAULT NULL', () => {
    const sql = toChildTableSql({ name: 't3', columns: { left_at: 'timestamp' } });
    expect(sql).toContain('`left_at` timestamp DEFAULT NULL');
  });

  it('renders an enum with its values, not a varchar stand-in', () => {
    const sql = toChildTableSql({
      name: 't4',
      columns: {
        state: { type: 'enum', values: ['active', 'left'], notNull: true, default: 'active' }
      }
    });

    expect(sql).toContain("`state` ENUM('active', 'left') NOT NULL DEFAULT 'active'");
  });

  it('refuses an enum with no values rather than emitting ENUM()', () => {
    expect(() => toChildTableSql({ name: 't5', columns: { s: { type: 'enum' } } })).toThrow(
      /requires a non-empty `values` list/
    );
  });
});

describe('toSqlFile', () => {
  it('marks the output generated so nobody hand-edits it', () => {
    const file = toSqlFile(resolveAppSchema(notesDefinition));

    expect(file).toContain("-- Generated from the 'notes' defineService declaration.");
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

  it('rejects redeclaring an index the primary table already emits', () => {
    // MySQL error 1061 otherwise, and only at apply time. The primary table always
    // carries `status` and `citizenid_status`.
    for (const collide of [['status'], ['citizenid', 'status']]) {
      expect(() => resolveAppSchema({ ...notesDefinition, indexes: [collide] })).toThrow(
        /is emitted twice/
      );
    }
  });

  it('rejects two child-table indexes with the same name', () => {
    expect(() =>
      resolveAppSchema({
        id: 'x',
        schema: { a: 'string' },
        childTables: [{ name: 'kid', columns: { b: 'int' }, indexes: [['b'], ['b']] }]
      })
    ).toThrow(/emits index name 'b' twice/);
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
    ['a numeric default', 0, 'DEFAULT 0'],
    ['a string default', 'pending', "DEFAULT 'pending'"],
    ['a boolean default', true, 'DEFAULT 1'],
    ['an explicit null default', null, 'DEFAULT NULL']
  ])('renders %s', (_label, value, expected) => {
    const out = toCreateTableSql(
      resolveAppSchema({ id: 'defaults', schema: { field: { type: 'int', default: value } } })
    );

    expect(out).toContain(`\`field\` int(11) ${expected}`);
  });

  it('combines notNull with a default', () => {
    const out = toCreateTableSql(
      resolveAppSchema({
        id: 'nn',
        schema: { flag: { type: 'bool', notNull: true, default: 0 } }
      })
    );

    expect(out).toContain('`flag` tinyint(1) NOT NULL DEFAULT 0');
  });

  it('escapes a quote in a string default', () => {
    const out = toCreateTableSql(
      resolveAppSchema({ id: 'q', schema: { label: { type: 'string', default: "it's" } } })
    );

    expect(out).toContain("DEFAULT 'it''s'");
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
