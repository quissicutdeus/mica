// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { resolveAppSchema } from '../lib/defineService';
import { auditLogDdl, expectedShape, toChildTableSql, toCreateTableSql } from '../lib/schemaSql';
import {
  planAppMigration,
  planAuditLogMigration,
  planChildMigration,
  isNoop,
  type LiveTable
} from '../lib/migrate';
import '../services/index';

/**
 * The planner is the whole point of the exercise, and it is pure — no database, no
 * FiveM. `SchemaMigrator` only reads `information_schema` and runs what this produces.
 */

const schema = resolveAppSchema({
  id: 'widgets',
  schema: {
    title: { type: 'string', length: 64 },
    body: 'text',
    pinned: { type: 'bool', notNull: true, default: 0, index: true }
  },
  indexes: [{ name: 'citizenid_title', columns: ['citizenid', 'title'] }]
});

const SHAPE = expectedShape(schema);

/** A live table that already matches the declaration exactly. */
const inSync = (): LiveTable => ({
  exists: true,
  columns: SHAPE.columns.map((c) => ({
    name: c.name,
    type: declaredTypeOf(c.name),
    nullable: !c.def.notNull
  })),
  indexes: ['PRIMARY', ...SHAPE.indexes.map((i) => i.name)]
});

/** What MySQL would report in COLUMN_TYPE for each declared column. */
function declaredTypeOf(name: string): string {
  switch (name) {
    case 'id':
      return 'int(11)';
    case 'citizenid':
      return 'varchar(50)';
    case 'title':
      return 'varchar(64)';
    case 'body':
      return 'text';
    case 'pinned':
      return 'tinyint(1)';
    case 'status':
      return "enum('active','deleted')";
    default:
      return 'timestamp';
  }
}

const sqlOf = (plan: { additive: { sql: string }[] }) => plan.additive.map((s) => s.sql);

const MISSING: LiveTable = { exists: false, columns: [], indexes: [] };

describe('planAppMigration', () => {
  it('does nothing when the table already matches', () => {
    const plan = planAppMigration(schema, inSync());
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual([]);
    expect(isNoop(plan)).toBe(true);
  });

  it('adds a column the declaration gained', () => {
    // The case that motivated all of this: `archived_at` reached fresh installs through
    // CREATE TABLE and never reached an upgraded one.
    const live = inSync();
    live.columns = live.columns.filter((c) => c.name !== 'body');

    const plan = planAppMigration(schema, live);
    expect(sqlOf(plan)).toEqual(['ALTER TABLE `mica_widgets` ADD COLUMN `body` text DEFAULT NULL']);
  });

  it('adds a missing index', () => {
    const live = inSync();
    live.indexes = live.indexes.filter((i) => i !== 'citizenid_title');

    const plan = planAppMigration(schema, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `mica_widgets` ADD KEY `citizenid_title` (`citizenid`, `title`)'
    ]);
  });

  it('adds a per-column index declared with `index: true`', () => {
    const live = inSync();
    live.indexes = live.indexes.filter((i) => i !== 'citizenid_pinned');

    const plan = planAppMigration(schema, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `mica_widgets` ADD KEY `citizenid_pinned` (`citizenid`, `pinned`)'
    ]);
  });

  /**
   * MICA-388: a missing table used to plan nothing at all, "import mica.sql" on the report, so
   * `micaschema apply` created nothing and then said the schema was up to date.
   */
  it('plans the whole create for a table that does not exist, and nothing to patch', () => {
    const plan = planAppMigration(schema, MISSING, { ownerTable: true });
    expect(plan.missingTable).toBe(true);
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual([]);
    expect(isNoop(plan)).toBe(false);
    expect(plan.create).toEqual({
      description: 'create table mica_widgets',
      sql: toCreateTableSql(schema, { ownerTable: true })
    });
    // The generated files' form, never the bootstrap's plain one: running it twice is a no-op.
    expect(plan.create?.sql).toMatch(/^CREATE TABLE IF NOT EXISTS `mica_widgets` \(/);
    expect(plan.create?.sql).toContain('`citizenid` varchar(50) NOT NULL');
  });

  it('sizes a created citizenid for the framework, and the wider one while it is unknown', () => {
    expect(planAppMigration(schema, MISSING, { ownerTable: false }).create?.sql).toContain(
      '`citizenid` varchar(60) NOT NULL'
    );
    expect(planAppMigration(schema, MISSING).create?.sql).toBe(
      toCreateTableSql(schema, { ownerTable: false })
    );
  });

  it('plans no create for a table that exists', () => {
    expect(planAppMigration(schema, inSync()).create).toBeNull();
  });

  it('never emits DROP, RENAME or MODIFY', () => {
    // The safety property the whole design rests on. A rename is indistinguishable from
    // a drop plus an add, so guessing risks data.
    const live = inSync();
    live.columns = live.columns.filter((c) => c.name !== 'body');
    live.columns.push({ name: 'legacy_body', type: 'text', nullable: true });

    const plan = planAppMigration(schema, live);
    for (const sql of sqlOf(plan)) {
      expect(sql).not.toMatch(/\b(DROP|RENAME|MODIFY|CHANGE)\b/i);
    }
  });

  it('reports an undeclared live column instead of dropping it', () => {
    const live = inSync();
    live.columns.push({ name: 'someone_elses', type: 'varchar(20)', nullable: true });

    const plan = planAppMigration(schema, live);
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual(['mica_widgets.someone_elses exists but is not declared']);
  });

  it('reports a type mismatch instead of altering it', () => {
    const live = inSync();
    live.columns = live.columns.map((c) =>
      c.name === 'title' ? { ...c, type: 'varchar(16)' } : c
    );

    const plan = planAppMigration(schema, live);
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual(['mica_widgets.title is `varchar(16)` but declared `varchar(64)`']);
  });

  it('reports a status enum that has gained a value', () => {
    // Adding a status to the declaration is a real change that needs a MODIFY, which
    // this refuses to do. Silently ignoring it would let writes fail later.
    const live = inSync();
    live.columns = live.columns.map((c) =>
      c.name === 'status' ? { ...c, type: "enum('active')" } : c
    );

    const plan = planAppMigration(schema, live);
    expect(plan.drift.some((d) => d.includes('status'))).toBe(true);
  });

  it('tolerates MySQL dropping the display width', () => {
    // MySQL 8.0.19+ reports `int` rather than `int(11)`. Treating that as drift would
    // print a false warning on every start.
    const live = inSync();
    live.columns = live.columns.map((c) =>
      c.name === 'id' ? { ...c, type: 'int' } : c.name === 'pinned' ? { ...c, type: 'tinyint' } : c
    );

    expect(planAppMigration(schema, live).drift).toEqual([]);
  });

  it('is case-insensitive about column and index names', () => {
    const live = inSync();
    live.columns = live.columns.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    live.indexes = live.indexes.map((i) => i.toUpperCase());

    expect(isNoop(planAppMigration(schema, live))).toBe(true);
  });

  it('refuses to add a missing auto-increment id', () => {
    const live = inSync();
    live.columns = live.columns.filter((c) => c.name !== 'id');

    const plan = planAppMigration(schema, live);
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual(['mica_widgets.id is missing and cannot be added safely']);
  });

  describe('a generated column (MICA-161)', () => {
    const genSchema = resolveAppSchema({
      id: 'genwidgets',
      schema: {
        a: 'string',
        b: 'string',
        pair: { type: 'string', length: 101, generatedAs: 'CONCAT(`a`, `b`)' }
      }
    });
    const genShape = expectedShape(genSchema);

    /** A live `pair` whose `information_schema` type never echoes the expression back. */
    const genLiveTypeOf = (name: string): string => {
      if (name === 'a' || name === 'b') return 'varchar(255)';
      if (name === 'pair') return 'varchar(101)';
      return declaredTypeOf(name);
    };
    const genLive = (): LiveTable => ({
      exists: true,
      columns: genShape.columns.map((c) => ({
        name: c.name,
        type: genLiveTypeOf(c.name),
        nullable: !c.def.notNull
      })),
      indexes: ['PRIMARY', ...genShape.indexes.map((i) => i.name)]
    });

    it('is satisfied by presence alone — the live type never matches the declared expression', () => {
      // If this printed drift, it would print it forever: `information_schema` never
      // reports the `GENERATED ALWAYS AS (...)` clause back, so a byte-for-byte
      // comparison against the declaration can never agree, even when the column is
      // exactly as declared.
      const plan = planAppMigration(genSchema, genLive());
      expect(plan.additive).toEqual([]);
      expect(plan.drift).toEqual([]);
      expect(isNoop(plan)).toBe(true);
    });

    it('is still added, plainly, when missing', () => {
      const live = genLive();
      live.columns = live.columns.filter((c) => c.name !== 'pair');

      const plan = planAppMigration(genSchema, live);
      expect(sqlOf(plan)).toEqual([
        'ALTER TABLE `mica_genwidgets` ADD COLUMN `pair` varchar(101) ' +
          'GENERATED ALWAYS AS (CONCAT(`a`, `b`)) VIRTUAL'
      ]);
    });
  });
});

import { SchemaMigrator } from '../lib/SchemaMigrator';
import { setOwnerTableResolver } from '../lib/ownerWidth';
import { bootstrapTables, createStatements, SCHEMA_MIGRATIONS_TABLE } from '../lib/schemaSql';

const liveChild = (): LiveTable => ({
  exists: true,
  columns: [
    { name: 'id', type: 'int(11)', nullable: false },
    { name: 'widget_id', type: 'int(11)', nullable: false },
    { name: 'label', type: 'varchar(30)', nullable: true },
    { name: 'archived_at', type: 'timestamp', nullable: true }
  ],
  indexes: ['PRIMARY', 'widget']
});

describe('planChildMigration', () => {
  const child = {
    name: 'mica_widget_parts',
    columns: {
      widget_id: { type: 'int' as const, notNull: true },
      label: { type: 'string' as const, length: 30 },
      archived_at: { type: 'timestamp' as const }
    },
    indexes: [{ name: 'widget', columns: ['widget_id'] }]
  };

  it('does nothing when already in sync', () => {
    expect(isNoop(planChildMigration(child, liveChild()))).toBe(true);
  });

  it('adds a column a child table gained', () => {
    // Exactly the archived_at case, which is why child tables are covered at all.
    const live = liveChild();
    live.columns = live.columns.filter((c) => c.name !== 'archived_at');

    const plan = planChildMigration(child, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `mica_widget_parts` ADD COLUMN `archived_at` timestamp DEFAULT NULL'
    ]);
  });

  it("plans the child table's whole create when it does not exist", () => {
    const plan = planChildMigration(child, MISSING, { ownerTable: true });
    expect(plan.missingTable).toBe(true);
    expect(plan.additive).toEqual([]);
    expect(plan.create).toEqual({
      description: 'create table mica_widget_parts',
      sql: toChildTableSql(child, { ownerTable: true })
    });
    expect(plan.create?.sql).toMatch(/^CREATE TABLE IF NOT EXISTS `mica_widget_parts` \(/);
  });

  it('does not expect an id when the child opts out of one', () => {
    const noId = { ...child, autoIncrementId: false };
    const live = liveChild();
    live.columns = live.columns.filter((c) => c.name !== 'id');

    expect(planChildMigration(noId, live).drift).toEqual([]);
  });
});

const statement = (name: string) => ({
  description: `add column mica_widgets.${name}`,
  sql: `ALTER TABLE \`mica_widgets\` ADD COLUMN \`${name}\` text`
});

describe('SchemaMigrator', () => {
  it('report() never writes to the database', async () => {
    // `../services/index`, imported above for `declaredServices`, pulls in
    // `Notifications.ts`, which prunes stale rows at module scope on import — a real
    // (mocked) `Database.query` call this file never clears between tests. Clear it so
    // this assertion is about `report()`, not about an unrelated import-time side effect.
    dbMock.query.mockClear();
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([]);
    await SchemaMigrator.report();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('apply() runs every additive statement plan() finds', async () => {
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      {
        table: 'mica_widgets',
        missingTable: false,
        create: null,
        additive: [
          {
            description: 'add column mica_widgets.body',
            sql: 'ALTER TABLE `mica_widgets` ADD COLUMN `body` text'
          }
        ],
        drift: []
      }
    ]);
    dbMock.query.mockResolvedValue([]);

    const result = await SchemaMigrator.apply();

    expect(dbMock.query).toHaveBeenCalledWith(
      'ALTER TABLE `mica_widgets` ADD COLUMN `body` text',
      []
    );
    expect(result).toEqual({
      applied: ['add column mica_widgets.body'],
      failed: null,
      remaining: []
    });
  });

  it('apply() never runs a drift-only plan', async () => {
    // See the comment in the previous test — same unrelated import-time call to clear.
    dbMock.query.mockClear();
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      {
        table: 'mica_widgets',
        missingTable: false,
        create: null,
        additive: [],
        drift: ['mica_widgets.x exists but is not declared']
      }
    ]);
    dbMock.query.mockResolvedValue([]);

    const result = await SchemaMigrator.apply();

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: [], failed: null, remaining: [] });
  });

  /**
   * MySQL DDL auto-commits per statement, so the statements before a failure are applied
   * and permanent. Rejecting the whole call threw that list away and told the operator only
   * that something had gone wrong — in the one command that changes a live database.
   */
  it('apply() keeps what already ran when a later statement throws', async () => {
    dbMock.query.mockClear();
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      {
        table: 'mica_widgets',
        missingTable: false,
        create: null,
        additive: [statement('body'), statement('subtitle')],
        drift: []
      },
      {
        table: 'mica_notes',
        missingTable: false,
        create: null,
        additive: [
          { description: 'add column mica_notes.pinned', sql: 'ALTER TABLE `mica_notes` ...' }
        ],
        drift: []
      }
    ]);
    dbMock.query.mockImplementation((sql: string) => {
      if (sql.includes('subtitle')) return Promise.reject(new Error('Duplicate column name'));
      return Promise.resolve([]);
    });

    const result = await SchemaMigrator.apply();

    expect(result.applied).toEqual(['add column mica_widgets.body']);
    expect(result.failed).toEqual({
      description: 'add column mica_widgets.subtitle',
      error: 'Duplicate column name'
    });
    // Statements after the failure span the plan boundary, so they are counted across
    // plans rather than per table — one flat list is what an operator reads.
    expect(result.remaining).toEqual(['add column mica_notes.pinned']);
    // And nothing past the failure was attempted.
    expect(dbMock.query).toHaveBeenCalledTimes(2);
  });

  it('apply() still throws when the plan itself cannot be built', async () => {
    // No partial progress to report: nothing has been applied, and the caller's `.catch()`
    // at the command boundary is what surfaces it.
    vi.spyOn(SchemaMigrator, 'plan').mockRejectedValueOnce(
      new Error('could not determine the current database')
    );

    await expect(SchemaMigrator.apply()).rejects.toThrow(
      'could not determine the current database'
    );
  });

  it('plans migration by querying information_schema', async () => {
    (globalThis as any).GetConvar = vi.fn().mockReturnValue('true');
    dbMock.scalar.mockResolvedValueOnce('mica_db');
    // Return empty columns for readLiveTable query to simulate missing tables
    dbMock.query.mockResolvedValue([]);

    const plans = await SchemaMigrator.plan();

    expect(dbMock.scalar).toHaveBeenCalledWith('SELECT DATABASE()', []);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].missingTable).toBe(true);
  });

  it('reports schema status when in sync', async () => {
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await SchemaMigrator.report();

    expect(logSpy).toHaveBeenCalledWith('[mica] schema is up to date.');
  });

  it('reports schema differences when missing tables or drift exist', async () => {
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      {
        table: 'mica_widgets',
        missingTable: true,
        create: { description: 'create table mica_widgets', sql: 'CREATE TABLE IF NOT EXISTS …' },
        additive: [],
        drift: ['mica_widgets.foo exists but is not declared']
      }
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await SchemaMigrator.report();

    expect(logSpy).toHaveBeenCalledWith('[mica] schema differences:');
    expect(logSpy).toHaveBeenCalledWith('  create table mica_widgets (it does not exist)');
    expect(logSpy).toHaveBeenCalledWith(
      "[mica] run 'micaschema apply' from the server console to create and add what is " +
        'listed above, after taking a backup.'
    );
    expect(logSpy).not.toHaveBeenCalledWith('[mica] schema is up to date.');
    expect(logSpy.mock.calls.flat().join('\n')).not.toMatch(/import mica\.sql/);
    expect(logSpy).toHaveBeenCalledWith(
      '  needs a human: mica_widgets.foo exists but is not declared'
    );
  });
});

/**
 * MICA-388. `micaschema apply` creates a missing table — the audit ledger, an app's table, a
 * child table — from the same DDL the first-start bootstrap runs, in the bootstrap's order,
 * before any column or index is added.
 */
describe('a missing table (MICA-388)', () => {
  const createOf = (table: string, sql: string) => ({
    table,
    missingTable: true,
    create: { description: `create table ${table}`, sql },
    additive: [],
    drift: []
  });

  it('plans the audit ledger as its create when missing, and leaves it alone when not', () => {
    expect(planAuditLogMigration(MISSING, { ownerTable: true })).toEqual(
      createOf('mica_audit_logs', auditLogDdl({ ownerTable: true }))
    );
    expect(planAuditLogMigration(MISSING).create?.sql).toBe(auditLogDdl({ ownerTable: false }));
    expect(
      isNoop(
        planAuditLogMigration({
          exists: true,
          columns: [{ name: 'id', type: 'int(11)', nullable: false }],
          indexes: ['PRIMARY']
        })
      )
    ).toBe(true);
  });

  it('plan() lists every table in the bootstrap order, each with the bootstrap DDL', async () => {
    setOwnerTableResolver(() => true);
    try {
      dbMock.scalar.mockResolvedValueOnce('mica_db');
      dbMock.query.mockResolvedValue([]);

      const plans = await SchemaMigrator.plan();

      // The bootstrap's own list, less the migrations ledger `runPendingMigrations` creates.
      const expected = bootstrapTables().filter((t) => t !== SCHEMA_MIGRATIONS_TABLE);
      expect(plans.map((p) => p.table)).toEqual(expected);
      // Its statements too, less the ledger and the seed, in IF NOT EXISTS form.
      const bootstrap = createStatements(true).filter((sql) => sql.startsWith('CREATE TABLE '));
      expect(bootstrap.length).toBe(expected.length + 1);
      expect(plans.map((p) => p.create?.sql)).toEqual(
        bootstrap
          .slice(1)
          .map((sql) => sql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '))
      );
      expect(plans.every((p) => p.missingTable && p.additive.length === 0)).toBe(true);
    } finally {
      setOwnerTableResolver(() => null);
    }
  });

  it('plan() puts every foreign key target before the table that references it', async () => {
    dbMock.scalar.mockResolvedValueOnce('mica_db');
    dbMock.query.mockResolvedValue([]);

    const plans = await SchemaMigrator.plan();
    const at = new Map(plans.map((p, i) => [p.table, i]));

    let references = 0;
    for (const [i, plan] of plans.entries()) {
      for (const [, target] of (plan.create?.sql ?? '').matchAll(/REFERENCES `([^`]+)`/g)) {
        references += 1;
        // A self-reference (a reply onto its own table) resolves inside its own create.
        expect(at.get(target), `${plan.table} references ${target}`).toBeLessThanOrEqual(i);
      }
    }
    // A loop over no references would assert nothing; the declarations carry dozens.
    expect(references).toBeGreaterThan(5);
  });

  it('apply() runs every create, in plan order, before any column or index', async () => {
    dbMock.query.mockClear();
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      {
        table: 'mica_widgets',
        missingTable: false,
        create: null,
        additive: [statement('body')],
        drift: []
      },
      createOf('mica_parents', 'CREATE TABLE IF NOT EXISTS `mica_parents` (…)'),
      createOf('mica_children', 'CREATE TABLE IF NOT EXISTS `mica_children` (…)')
    ]);
    dbMock.query.mockResolvedValue([]);

    const result = await SchemaMigrator.apply();

    expect(dbMock.query.mock.calls.map(([sql]) => sql)).toEqual([
      'CREATE TABLE IF NOT EXISTS `mica_parents` (…)',
      'CREATE TABLE IF NOT EXISTS `mica_children` (…)',
      'ALTER TABLE `mica_widgets` ADD COLUMN `body` text'
    ]);
    expect(result).toEqual({
      applied: [
        'create table mica_parents',
        'create table mica_children',
        'add column mica_widgets.body'
      ],
      failed: null,
      remaining: []
    });
  });

  it('apply() stops at a failed create, attempting no later create nor any column', async () => {
    dbMock.query.mockClear();
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      createOf('mica_parents', 'CREATE TABLE IF NOT EXISTS `mica_parents` (…)'),
      createOf('mica_children', 'CREATE TABLE IF NOT EXISTS `mica_children` (…)'),
      {
        table: 'mica_widgets',
        missingTable: false,
        create: null,
        additive: [statement('body')],
        drift: []
      }
    ]);
    dbMock.query.mockImplementation((sql: string) =>
      sql.includes('mica_parents')
        ? Promise.reject(new Error("Can't create table"))
        : Promise.resolve([])
    );

    const result = await SchemaMigrator.apply();

    expect(result).toEqual({
      applied: [],
      failed: { description: 'create table mica_parents', error: "Can't create table" },
      remaining: ['create table mica_children', 'add column mica_widgets.body']
    });
    expect(dbMock.query).toHaveBeenCalledTimes(1);
  });

  it('report() never says up to date while a table is missing', async () => {
    vi.spyOn(SchemaMigrator, 'plan').mockResolvedValueOnce([
      createOf('mica_widgets', 'CREATE TABLE IF NOT EXISTS `mica_widgets` (…)')
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await SchemaMigrator.report();

    expect(logSpy).not.toHaveBeenCalledWith('[mica] schema is up to date.');
    expect(logSpy).toHaveBeenCalledWith('  create table mica_widgets (it does not exist)');
  });
});
