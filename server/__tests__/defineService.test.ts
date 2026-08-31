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

import { CITIZENID_MAX_LENGTH, citizenIdFromIdentifier } from '@gphone/shared/framework';

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

  it('keeps filterable opt-in, and independent of whether the column is writable', () => {
    // This test asserted `['phone']` until MICA-137 — it pinned the coupling rather than
    // the rule, and `immutable` below is the shape that made the coupling a live bug:
    // searchable because it identifies the row, unwritable because it must never be renamed.
    const resolved = resolveAppSchema({
      id: 'x',
      schema: {
        phone: { type: 'string', clientFilterable: true },
        note: 'text',
        immutable: { type: 'string', clientWritable: false, clientFilterable: true }
      }
    });

    expect(resolved.clientFilterable).toEqual(['phone', 'immutable']);
    expect(resolved.clientWritable).toEqual(['phone', 'note']);
  });

  it('cannot make citizenid filterable, because it cannot be declared at all', () => {
    /**
     * Pins `IMPLICIT_COLUMNS`, **not** the derivation this ticket changed — and the
     * distinction is the whole point of writing it here. `citizenid` is not filterable
     * because `resolveAppSchema` throws on any schema naming it, so it never becomes a field
     * and no derivation could reach it. It was never the write coupling that held this, and
     * removing that coupling therefore costs nothing: a public read still cannot be pivoted
     * into "which of these accounts belong to one player".
     */
    expect(() =>
      resolveAppSchema({
        id: 'z',
        access: { read: 'public', write: 'owner' },
        paging: { pageSize: 10, maxPageSize: 20 },
        schema: { citizenid: { type: 'string', clientFilterable: true } }
      })
    ).toThrow(/supplied by the framework/);
  });

  it('makes nothing client-writable when the server authors the rows', () => {
    // Mail: rows arrive from jobs and dispatches, never from the phone's owner. The row
    // still belongs to one citizenid, which is why the *read* axis stays `owner` — that
    // is the distinction the old single `scope` could not express.
    const resolved = resolveAppSchema({
      id: 'mail',
      access: { read: 'owner', write: 'server' },
      schema: { sender: 'string', subject: { type: 'string', clientFilterable: true } }
    });

    expect(resolved.clientWritable).toEqual([]);
    // Also pinned the MICA-137 coupling: `write: 'server'` closed the write path and took
    // the filter path with it, though the read is owner-scoped and the generic `get` is
    // registered. Shutting writes says nothing about what an owner may search their own
    // rows by.
    expect(resolved.clientFilterable).toEqual(['subject']);
    expect(resolved.access).toEqual({ read: 'owner', write: 'server' });
    expect(resolved.columns).toContain('sender');
  });

  it('shuts the generic write path when writes are member-scoped', () => {
    // Rows several players can see cannot be authorized by ownership, so nothing is
    // client-writable through the generic path — membership checks must be explicit.
    //
    // Its `clientFilterable` assertion is **vacuous** after MICA-137, and left that way on
    // purpose: this schema declares nothing filterable, so it passes on that alone rather
    // than on the coupling. Adding a `clientFilterable: true` column to "strengthen" it would
    // fail, correctly — a members service now keeps its declared filterable set, and what
    // makes that harmless is `accessLockdown` setting `disableGet`, which is one place rather
    // than a second rule in the derivation.
    const resolved = resolveAppSchema({
      id: 'shared_rows',
      access: {
        read: 'members',
        write: 'members',
        membership: { table: 'gphone_members', foreignKey: 'parent_id' }
      },
      schema: { name: 'string' }
    });

    expect(resolved.clientWritable).toEqual([]);
    expect(resolved.clientFilterable).toEqual([]);
  });

  it('fills in the membership defaults it did not have to be told', () => {
    const resolved = resolveAppSchema({
      id: 'rides',
      access: {
        read: 'members',
        write: 'members',
        membership: { table: 'gphone_ride_members', foreignKey: 'ride_id' }
      },
      schema: { destination: 'string' }
    });

    expect(resolved.membership).toEqual({
      table: 'gphone_ride_members',
      foreignKey: 'ride_id',
      localKey: 'id',
      citizenColumn: 'citizenid',
      liveWhileNull: null
    });
  });

  it('refuses a members axis with no membership to check', () => {
    expect(() =>
      resolveAppSchema({
        id: 'nomembers',
        access: { read: 'members', write: 'members' },
        schema: { label: 'string' }
      })
    ).toThrow(/no 'membership'/);
  });

  it('refuses a membership table that is the primary table', () => {
    // MySQL error 1093 — it cannot subquery the table it is updating — and it would only
    // surface at runtime, on a member write.
    expect(() =>
      resolveAppSchema({
        id: 'selfref',
        access: {
          read: 'members',
          write: 'members',
          membership: { table: 'gphone_selfref', foreignKey: 'parent_id' }
        },
        schema: { label: 'string' }
      })
    ).toThrow(/is the primary table/);
  });

  it('refuses a membership identifier that is not a safe SQL identifier', () => {
    // Every one of these is interpolated, because MySQL cannot parameterize an
    // identifier. Same rule as the column allowlist, extended across the join.
    expect(() =>
      resolveAppSchema({
        id: 'injected',
        access: {
          read: 'members',
          write: 'members',
          membership: { table: 'gphone_m; DROP TABLE users', foreignKey: 'parent_id' }
        },
        schema: { label: 'string' }
      })
    ).toThrow(/must be lower_snake_case/);
  });
});

describe('resolveAppSchema — rejections', () => {
  it('refuses a schema that redeclares a framework column', () => {
    expect(() =>
      resolveAppSchema({ id: 'x', schema: { citizenid: 'string', title: 'string' } })
    ).toThrow(/supplied by the framework/);
  });

  it('refuses a column that is both private and filterable', () => {
    /**
     * A column withheld from the read projection but accepted as a `WHERE` predicate can be
     * tested for without ever being returned: guess, count the rows, read the value off the
     * count. Only reachable since MICA-137 stopped filtering implying writability — the
     * pairing needs `clientWritable: false` to be interesting, and that used to empty the
     * filter list on its own.
     *
     * A throw rather than a quiet exclusion, because a flag honoured everywhere except the
     * one derivation that mattered is exactly the bug this ticket fixed.
     */
    expect(() =>
      resolveAppSchema({
        id: 'x',
        access: { read: 'public', write: 'owner' },
        paging: { pageSize: 10, maxPageSize: 20 },
        schema: { token: { type: 'string', private: true, clientFilterable: true } }
      })
    ).toThrow(/both 'private' and 'clientFilterable'/);
  });

  it('allows private and filterable separately, so the refusal is about the pairing', () => {
    expect(() =>
      resolveAppSchema({
        id: 'x',
        schema: {
          heavy: { type: 'blob', private: true },
          phone: { type: 'string', clientFilterable: true }
        }
      })
    ).not.toThrow();
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

/**
 * `private` narrows the generic list read on **both** access axes (MICA-110).
 *
 * It began as a public-read rule — an app-specific secret on an otherwise public table —
 * and the weight case is the second reason a column earns it: `gphone_media.data` is a
 * whole base64 photo, so an unprojected owner read shipped hundreds of kilobytes a row to
 * draw a grid of 123px tiles. The ownership predicate bounds *who* may read, and nothing
 * about *how much*.
 */
describe('private columns and the list projection', () => {
  const heavy: ServiceDefinition = {
    id: 'heavy_list',
    schema: {
      caption: { type: 'string', length: 255 },
      payload: { type: 'mediumtext', private: true }
    }
  };

  it('withholds a private column from an owner read as well as a public one', () => {
    const resolved = resolveAppSchema(heavy);

    expect(resolved.listColumns).not.toContain('payload');
    expect(resolved.publicColumns).not.toContain('payload');
  });

  it('keeps citizenid for the owner, which no public reader ever gets', () => {
    // The two lists are siblings rather than the same list. An owner reading their own
    // rows has every business seeing their own citizenid; a public reader correlating two
    // deliberately-separate accounts back to one person does not.
    const resolved = resolveAppSchema(heavy);

    expect(resolved.listColumns).toContain('citizenid');
    expect(resolved.publicColumns).not.toContain('citizenid');
  });

  it('leaves a table with nothing private selecting exactly what it always did', async () => {
    // The property that keeps this change additive. Every other service passes no
    // projection at all, so `findAll` emits the byte-identical `SELECT *` that several
    // repositoryFactory subclasses and Repository.test.ts's exact query strings rely on.
    const resolved = resolveAppSchema(notesDefinition);
    expect(resolved.listColumns).toEqual(resolved.columns);

    const repo = buildRepository(resolved);
    dbMock.query.mockClear();
    dbMock.query.mockResolvedValue([]);
    await repo.findAll({} as any);

    expect(String(dbMock.query.mock.calls[0][0])).toContain('SELECT * FROM');
  });

  it('is a read projection and not a write rule — a private column stays writable', () => {
    // The distinction MICA-110 turns on: the camera still creates a row with its bytes.
    // Marking the column private must not quietly close the path that fills it.
    expect(resolveAppSchema(heavy).clientWritable).toContain('payload');
  });
});

/** Capture the events ServiceEndpoint registers, so the wiring is observable. */
const mountAndCapture = (definition: ServiceDefinition): string[] => {
  const registered: string[] = [];
  (globalThis as Record<string, unknown>).onNet = (event: string) => {
    registered.push(event);
  };
  defineService(definition);
  return registered;
};

describe('defineService — event registration', () => {
  it('registers the four generic CRUD events for an owner-scoped app', () => {
    const events = mountAndCapture({ id: 'owned_a', schema: { label: 'string' } });

    expect(events.toSorted()).toEqual([
      'gphone:server:owned_a:create',
      'gphone:server:owned_a:delete',
      'gphone:server:owned_a:get',
      'gphone:server:owned_a:update'
    ]);
  });

  it('registers nothing generic when both axes are member-scoped', () => {
    // The important half: not just an empty clientWritable, but no generic endpoint
    // existing at all. `get` goes too, which the old `shared` scope kept — a membership
    // read needs the parent id, and the generic filter path cannot require one, so the
    // endpoint it left registered could only ever answer by ownership.
    const events = mountAndCapture({
      id: 'shared_a',
      access: {
        read: 'members',
        write: 'members',
        membership: { table: 'gphone_shared_a_members', foreignKey: 'parent_id' }
      },
      schema: { label: 'string' }
    });

    expect(events).toEqual([]);
  });

  it('registers get and delete but not create or update when the server authors', () => {
    // A server-authored row still belongs to one citizenid, so reading and deleting
    // your own mail is legitimate. Only authoring is closed.
    const events = mountAndCapture({
      id: 'authored_a',
      access: { read: 'owner', write: 'server' },
      schema: { sender: 'string' }
    });

    expect(events.toSorted()).toEqual([
      'gphone:server:authored_a:delete',
      'gphone:server:authored_a:get'
    ]);
  });

  it('lets an explicit option override the access default', () => {
    const events = mountAndCapture({
      id: 'owned_b',
      schema: { label: 'string' },
      options: { disableUpdate: true, disableDelete: true }
    });

    expect(events.toSorted()).toEqual([
      'gphone:server:owned_b:create',
      'gphone:server:owned_b:get'
    ]);
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

  it('honors a non-cascading onDelete', () => {
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

describe('float columns (MICA-65)', () => {
  it('emits a plain SQL float, not a display-width int', () => {
    const sql = toChildTableSql({ name: 't0', columns: { x: 'float' } });
    expect(sql).toContain('`x` float DEFAULT NULL');
  });

  it('carries no length, value or int-style range check', () => {
    const resolved = resolveAppSchema({
      id: 'floatcheck',
      schema: { x: 'float' }
    });
    expect(resolved.columnRules.x).toEqual({
      type: 'float',
      maxLength: null,
      values: null,
      min: null,
      max: null
    });
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

describe('generated columns (MICA-161)', () => {
  it('emits GENERATED ALWAYS AS (...) VIRTUAL rather than an ordinary column definition', () => {
    const sql = toChildTableSql({
      name: 't6',
      columns: {
        a: 'string',
        b: 'string',
        pair: { type: 'string', length: 101, generatedAs: 'CONCAT(`a`, `b`)' }
      }
    });

    expect(sql).toContain('`pair` varchar(101) GENERATED ALWAYS AS (CONCAT(`a`, `b`)) VIRTUAL');
    // None of the ordinary-column modifiers apply to a generated one.
    expect(sql).not.toMatch(/`pair`[^,]*NOT NULL/);
    expect(sql).not.toMatch(/`pair`[^,]*DEFAULT/);
  });

  it('is never client-writable, even on an owner-write table with no clientWritable flag', () => {
    const resolved = resolveAppSchema({
      id: 'genwrite',
      access: { read: 'owner', write: 'owner' },
      schema: {
        a: 'string',
        pair: { type: 'string', length: 50, generatedAs: 'CONCAT(`a`, `a`)' }
      }
    });

    expect(resolved.clientWritable).not.toContain('pair');
    expect(resolved.clientWritable).toContain('a');
  });

  it('refuses generatedAs paired with an explicit clientWritable: true', () => {
    expect(() =>
      resolveAppSchema({
        id: 'genconflict',
        schema: {
          pair: { type: 'string', generatedAs: "CONCAT('a','b')", clientWritable: true }
        }
      })
    ).toThrow(/generatedAs.*but also 'clientWritable: true'/);
  });

  it('refuses generatedAs paired with a default', () => {
    expect(() =>
      resolveAppSchema({
        id: 'gendefault',
        schema: {
          pair: { type: 'string', generatedAs: "CONCAT('a','b')", default: 'x' }
        }
      })
    ).toThrow(/generatedAs.*but also declares a default/);
  });

  it('refuses generatedAs paired with defaultNow', () => {
    expect(() =>
      resolveAppSchema({
        id: 'gendefaultnow',
        schema: {
          pair: { type: 'timestamp', generatedAs: 'NOW()', defaultNow: true }
        }
      })
    ).toThrow(/generatedAs.*but also declares a default/);
  });

  it('still carries a columnRule, so a stray write attempt is still checked rather than crashing', () => {
    const resolved = resolveAppSchema({
      id: 'genrule',
      schema: {
        pair: { type: 'string', length: 12, generatedAs: "CONCAT('a','b')" }
      }
    });

    expect(resolved.columnRules.pair).toMatchObject({ type: 'string', maxLength: 12 });
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
    expect(sql).toContain(`\`citizenid\` varchar(${CITIZENID_MAX_LENGTH}) NOT NULL`);
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

  it('honors notNull, length and index', () => {
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

/**
 * Public reads and keyset paging.
 *
 * A public table is the first thing in this codebase whose row count is not bounded by one
 * player's citizenid, and `Repository.findAll` returns every matching row. So the two arrive
 * together, and the declaration refuses to let them come apart.
 */
describe('resolveAppSchema — public reads and paging', () => {
  it('refuses a public read with no paging declared', () => {
    // The single highest-value rule here: it makes the unbounded findAll structurally
    // unreachable from a public table rather than merely discouraged in a docstring.
    expect(() =>
      resolveAppSchema({
        id: 'feed',
        access: { read: 'public', write: 'owner' },
        schema: { body: 'string' }
      })
    ).toThrow(/no 'paging' is declared/);
  });

  it('accepts a public read that declares paging, and fills in the defaults', () => {
    const resolved = resolveAppSchema({
      id: 'feed',
      access: { read: 'public', write: 'owner' },
      paging: {},
      schema: { body: 'string' }
    });

    expect(resolved.access).toEqual({ read: 'public', write: 'owner' });
    expect(resolved.paging).toEqual({ pageSize: 50, maxPageSize: 100 });
  });

  it('leaves paging null for every table that did not ask for it', () => {
    // Which is what keeps the unpaged findAll emitting byte-identical SQL: an owner-scoped
    // read is already bounded by its citizenid predicate and should not pay for a LIMIT.
    expect(resolveAppSchema({ id: 'plain', schema: { label: 'string' } }).paging).toBeNull();
  });

  it('refuses a maxPageSize below the default page size', () => {
    expect(() =>
      resolveAppSchema({
        id: 'backwards',
        paging: { pageSize: 50, maxPageSize: 10 },
        schema: { label: 'string' }
      })
    ).toThrow(/maxPageSize >= pageSize/);
  });

  it('still registers a plain get for a public table', () => {
    // Public changes *what* the get returns, not whether it exists. Contrast `members`,
    // which cannot express its read through the generic filter path at all.
    const registered: string[] = [];
    (globalThis as Record<string, unknown>).onNet = (event: string) => {
      registered.push(event);
    };
    defineService({
      id: 'feed_b',
      access: { read: 'public', write: 'owner' },
      paging: {},
      schema: { body: 'string' }
    });

    expect(registered).toContain('gphone:server:feed_b:get');
  });
});

describe('the citizenid column and the guard that fills it', () => {
  /**
   * MICA-158. `citizenid` is never client-writable, so `assertWritableValue` — the guard
   * that length-checks every other column against its declaration — deliberately never looks
   * at it. The only thing standing between a framework identifier and this column is
   * `citizenIdFromIdentifier`, and it can only be right if it is bounded by the same number
   * the column is.
   *
   * So this reads the width back out of generated DDL rather than asserting a literal. A
   * future widening that changes one and not the other fails here, which is the whole point:
   * a guard that is looser than its column silently truncates in non-strict mode, and a guard
   * that is tighter refuses players the column could have held.
   */
  it('derives the column width from the same constant that bounds the identifier', () => {
    const sql = toCreateTableSql(resolveAppSchema(notesDefinition));
    const declared = /`citizenid` varchar\((\d+)\)/.exec(sql);

    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(CITIZENID_MAX_LENGTH);
  });

  it('accepts an identifier of exactly the column width and refuses one character more', () => {
    // The boundary itself, because off-by-one here is the difference between "this player
    // has no phone" and "this player's rows get swept as unowned".
    const exact = 'x'.repeat(CITIZENID_MAX_LENGTH);
    const over = 'x'.repeat(CITIZENID_MAX_LENGTH + 1);

    expect(citizenIdFromIdentifier(exact)).toBe(exact);
    expect(citizenIdFromIdentifier(over)).toBeNull();
  });

  it('measures the trimmed identifier, not the raw one', () => {
    // Whitespace is stripped before the write, so a value that fits after trimming fits.
    const padded = `  ${'x'.repeat(CITIZENID_MAX_LENGTH)}  `;

    expect(citizenIdFromIdentifier(padded)).toBe('x'.repeat(CITIZENID_MAX_LENGTH));
  });
});
