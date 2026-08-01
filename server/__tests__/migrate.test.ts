import { describe, it, expect, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { resolveAppSchema } from '../lib/defineServerApp';
import { expectedShape } from '../lib/schemaSql';
import { planAppMigration, planChildMigration, isNoop, type LiveTable } from '../lib/migrate';

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
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `gphone_widgets` ADD COLUMN `body` text DEFAULT NULL'
    ]);
  });

  it('adds a missing index', () => {
    const live = inSync();
    live.indexes = live.indexes.filter((i) => i !== 'citizenid_title');

    const plan = planAppMigration(schema, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `gphone_widgets` ADD KEY `citizenid_title` (`citizenid`, `title`)'
    ]);
  });

  it('adds a per-column index declared with `index: true`', () => {
    const live = inSync();
    live.indexes = live.indexes.filter((i) => i !== 'citizenid_pinned');

    const plan = planAppMigration(schema, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `gphone_widgets` ADD KEY `citizenid_pinned` (`citizenid`, `pinned`)'
    ]);
  });

  it('reports a table that does not exist rather than trying to patch it', () => {
    const plan = planAppMigration(schema, { exists: false, columns: [], indexes: [] });
    expect(plan.missingTable).toBe(true);
    expect(plan.additive).toEqual([]);
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
    expect(plan.drift).toEqual(['gphone_widgets.someone_elses exists but is not declared']);
  });

  it('reports a type mismatch instead of altering it', () => {
    const live = inSync();
    live.columns = live.columns.map((c) =>
      c.name === 'title' ? { ...c, type: 'varchar(16)' } : c
    );

    const plan = planAppMigration(schema, live);
    expect(plan.additive).toEqual([]);
    expect(plan.drift).toEqual([
      'gphone_widgets.title is `varchar(16)` but declared `varchar(64)`'
    ]);
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
    expect(plan.drift).toEqual(['gphone_widgets.id is missing and cannot be added safely']);
  });
});

describe('planChildMigration', () => {
  const child = {
    name: 'gphone_widget_parts',
    columns: {
      widget_id: { type: 'int' as const, notNull: true },
      label: { type: 'string' as const, length: 30 },
      archived_at: { type: 'timestamp' as const }
    },
    indexes: [{ name: 'widget', columns: ['widget_id'] }]
  };

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

  it('does nothing when already in sync', () => {
    expect(isNoop(planChildMigration(child, liveChild()))).toBe(true);
  });

  it('adds a column a child table gained', () => {
    // Exactly the archived_at case, which is why child tables are covered at all.
    const live = liveChild();
    live.columns = live.columns.filter((c) => c.name !== 'archived_at');

    const plan = planChildMigration(child, live);
    expect(sqlOf(plan)).toEqual([
      'ALTER TABLE `gphone_widget_parts` ADD COLUMN `archived_at` timestamp DEFAULT NULL'
    ]);
  });

  it('does not expect an id when the child opts out of one', () => {
    const noId = { ...child, autoIncrementId: false };
    const live = liveChild();
    live.columns = live.columns.filter((c) => c.name !== 'id');

    expect(planChildMigration(noId, live).drift).toEqual([]);
  });
});
