// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { runCommand, unique } from '../lib/mica';
import { eventually, sleep } from '../lib/wait';

/**
 * The schema micaOS made for itself, against what the shipped file declares (MICA-289, MICA-301,
 * MICA-306).
 *
 * The box's wrapper imports nothing before this suite: micaOS starts on an empty database and
 * creates the schema on its first start (MICA-306), so every table and ledger row read here is
 * the bootstrap's. The release smoke test is the run that imports the file.
 *
 * The shipped `mica.esx.sql` is read from the running `mica` resource itself, so these check the
 * release that is actually running, not a copy in this resource that could be from another
 * build — and, since the bootstrap and that file are generated from one declaration, a table
 * the file names and the database lacks is the bootstrap's omission.
 */
const shippedSql = (): string => {
  const text = LoadResourceFile('mica', 'mica.esx.sql');
  if (!text) throw new Error('the mica resource ships no mica.esx.sql to read');
  return text;
};

/** Every `CREATE TABLE IF NOT EXISTS` the shipped file runs. */
const shippedTables = (sql: string): string[] =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z0-9_]+)`/g)].map((m) => m[1]);

/** The migration ids the shipped file seeds the ledger with, on a fresh import (MICA-301). */
const seededMigrations = (sql: string): string[] => {
  const at = sql.indexOf('INSERT IGNORE INTO `mica_schema_migrations`');
  if (at < 0) throw new Error('the shipped mica.esx.sql does not seed the migrations ledger');
  const block = sql.slice(at, sql.indexOf(';', at));
  return [...block.matchAll(/'(\d{4}_[a-z0-9_]+)'/g)].map((m) => m[1]);
};

/**
 * Ids that share the ledger without being migrations, each written by a feature that documents
 * it: the content-encryption marker (MICA-165) and the retention grace markers (MICA-167).
 */
const NOT_A_MIGRATION = /^(content-cipher:enabled|retention:[a-z0-9_]+:\d+d)$/;

const ledgerIds = async (): Promise<string[]> =>
  (await db.rows('SELECT `id` FROM `mica_schema_migrations` ORDER BY `id`')).map((r) =>
    String(r.id)
  );

/**
 * What micaOS says when its first-start create does not finish. It is printed once, early, and
 * this resource's console listener may not have been registered yet, so seeing none of these
 * proves nothing alone: the wrapper holds the whole console to the success line, and this reads
 * the tables. But a refusal this resource *did* hear is a failure with its reason attached.
 */
export const BOOTSTRAP_REFUSED =
  /this database may be half-created|creating micaOS's schema stopped|micaOS created nothing|could not tell whether this database already holds|another server is creating micaOS's schema/;

// ─── a table set aside, and put back ────────────────────────────────────────────────────────

/** Whether a table is in this database, as `information_schema` says. */
const tableExists = async (table: string): Promise<boolean> =>
  (await db.count(
    'SELECT COUNT(*) FROM information_schema.TABLES ' +
      'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ?',
    [table]
  )) > 0;

/**
 * Everything about a table's shape that a create could get wrong, one line per fact: each
 * column in order with its type, nullability, default, extra, generation and collation; each
 * index part; each foreign key with its rules; the engine and collation. Two equal lists are
 * the same table to anything micaOS reads. Empty when the table is not there.
 */
const shapeOf = async (table: string): Promise<string[]> => {
  const lines = (kind: string, rows: Record<string, unknown>[]) =>
    rows.map((row) => `${kind} ${JSON.stringify(Object.values(row))}`);
  const where = 'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ?';
  return [
    ...lines(
      'table',
      await db.rows(
        `SELECT \`ENGINE\`, \`TABLE_COLLATION\` FROM information_schema.TABLES ${where}`,
        [table]
      )
    ),
    ...lines(
      'column',
      await db.rows(
        'SELECT `ORDINAL_POSITION`, `COLUMN_NAME`, `COLUMN_TYPE`, `IS_NULLABLE`, ' +
          '`COLUMN_DEFAULT`, `EXTRA`, `GENERATION_EXPRESSION`, `COLLATION_NAME` ' +
          `FROM information_schema.COLUMNS ${where} ORDER BY \`ORDINAL_POSITION\``,
        [table]
      )
    ),
    ...lines(
      'index',
      await db.rows(
        'SELECT `INDEX_NAME`, `SEQ_IN_INDEX`, `COLUMN_NAME`, `NON_UNIQUE`, `SUB_PART` ' +
          `FROM information_schema.STATISTICS ${where} ORDER BY \`INDEX_NAME\`, \`SEQ_IN_INDEX\``,
        [table]
      )
    ),
    ...lines(
      'foreign key',
      await db.rows(
        'SELECT k.`CONSTRAINT_NAME`, k.`COLUMN_NAME`, k.`REFERENCED_TABLE_NAME`, ' +
          'k.`REFERENCED_COLUMN_NAME`, r.`DELETE_RULE`, r.`UPDATE_RULE` ' +
          'FROM information_schema.KEY_COLUMN_USAGE k ' +
          'JOIN information_schema.REFERENTIAL_CONSTRAINTS r ' +
          'ON r.`CONSTRAINT_SCHEMA` = k.`CONSTRAINT_SCHEMA` ' +
          'AND r.`CONSTRAINT_NAME` = k.`CONSTRAINT_NAME` ' +
          'WHERE k.`TABLE_SCHEMA` = DATABASE() AND k.`TABLE_NAME` = ? ' +
          'AND k.`REFERENCED_TABLE_NAME` IS NOT NULL ' +
          'ORDER BY k.`CONSTRAINT_NAME`, k.`ORDINAL_POSITION`',
        [table]
      )
    )
  ];
};

/** A throw naming what differs between two shapes of one table, or nothing when they agree. */
const expectSameShape = (table: string, before: string[], after: string[], when: string) => {
  const lost = before.filter((line) => !after.includes(line));
  const gained = after.filter((line) => !before.includes(line));
  if (lost.length === 0 && gained.length === 0 && before.length === after.length) return;
  throw new Error(
    `${table} ${when} is not the table the first start made: ` +
      `lost ${lost.slice(0, 3).join('; ') || 'nothing'}; ` +
      `gained ${gained.slice(0, 3).join('; ') || 'nothing'}`
  );
};

/**
 * The columns, indexes and foreign keys the shipped file's `CREATE TABLE` names for a table, read
 * from the file the running release carries, so a create is checked against what an owner who
 * imports it gets as well as against what the first start made.
 */
const shippedDeclaration = (sql: string, table: string) => {
  const head = `CREATE TABLE IF NOT EXISTS \`${table}\` (`;
  const at = sql.indexOf(head);
  if (at < 0) throw new Error(`the shipped mica.esx.sql does not create ${table}`);
  const block = sql.slice(at + head.length, sql.indexOf('\n) ENGINE', at));
  return {
    columns: [...block.matchAll(/^ {4}`([a-z0-9_]+)` /gm)].map((m) => m[1]),
    indexes: [...block.matchAll(/^ {4}(?:PRIMARY KEY|(?:UNIQUE )?KEY `([a-z0-9_]+)`)/gm)].map(
      (m) => m[1] ?? 'PRIMARY'
    ),
    foreignKeys: [...block.matchAll(/^ {4}CONSTRAINT `([a-z0-9_]+)` FOREIGN KEY/gm)].map(
      (m) => m[1]
    )
  };
};

/**
 * The live table holds exactly the shipped columns in order and every shipped index and foreign
 * key. An index the file does not name is allowed only under a foreign key's name: InnoDB makes
 * one for a referencing column no declared index leads with, on import as on a create.
 */
const expectShippedShape = async (sql: string, table: string): Promise<void> => {
  const declared = shippedDeclaration(sql, table);
  const columns = (
    await db.rows(
      'SELECT `COLUMN_NAME` AS `name` FROM information_schema.COLUMNS ' +
        'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? ORDER BY `ORDINAL_POSITION`',
      [table]
    )
  ).map((r) => String(r.name));
  if (JSON.stringify(columns) !== JSON.stringify(declared.columns)) {
    throw new Error(
      `${table} has columns ${columns.join(', ')}; mica.esx.sql declares ` +
        declared.columns.join(', ')
    );
  }
  const indexes = new Set(
    (
      await db.rows(
        'SELECT DISTINCT `INDEX_NAME` AS `name` FROM information_schema.STATISTICS ' +
          'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ?',
        [table]
      )
    ).map((r) => String(r.name))
  );
  const missingIndexes = declared.indexes.filter((name) => !indexes.has(name));
  const strayIndexes = [...indexes].filter(
    (name) => !declared.indexes.includes(name) && !declared.foreignKeys.includes(name)
  );
  if (missingIndexes.length > 0 || strayIndexes.length > 0) {
    throw new Error(
      `${table}'s indexes are not mica.esx.sql's: missing ${missingIndexes.join(', ') || 'none'}, ` +
        `undeclared ${strayIndexes.join(', ') || 'none'}`
    );
  }
  const foreignKeys = (
    await db.rows(
      'SELECT `CONSTRAINT_NAME` AS `name` FROM information_schema.REFERENTIAL_CONSTRAINTS ' +
        'WHERE `CONSTRAINT_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? ORDER BY `CONSTRAINT_NAME`',
      [table]
    )
  ).map((r) => String(r.name));
  if (JSON.stringify(foreignKeys) !== JSON.stringify([...declared.foreignKeys].sort())) {
    throw new Error(
      `${table} has foreign keys ${foreignKeys.join(', ') || 'none'}; mica.esx.sql declares ` +
        (declared.foreignKeys.join(', ') || 'none')
    );
  }
};

/** The citizenid width this database runs at, which every micaOS table must share. */
const citizenidWidth = async (table: string): Promise<string | null> => {
  const row = await db.row(
    'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
      "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `COLUMN_NAME` = 'citizenid'",
    [table]
  );
  return row ? String(row.type) : null;
};

/** On standalone (the ESX shape), and the same as the audit ledger's, which no create touches. */
const expectCitizenidWidth = async (table: string): Promise<void> => {
  const inUse = await citizenidWidth('mica_audit_logs');
  const width = await citizenidWidth(table);
  if (inUse !== 'varchar(60)' || width !== inUse) {
    throw new Error(
      `${table}.citizenid is ${String(width)} and mica_audit_logs.citizenid ${String(inUse)}; ` +
        'standalone takes the ESX width, varchar(60), on every table'
    );
  }
};

interface SetAside {
  table: string;
  /** `SHOW CREATE TABLE` as the first start made it: what puts it back if no create does. */
  ddl: string;
  backup: string;
  /** What can be written back: generated columns are computed, never inserted. */
  writable: string[];
  autoIncrement: number | null;
  shape: string[];
}

/**
 * Copy each table's rows aside, then drop the tables, children first. `tables` is in
 * foreign-key order, parents first, and must be every table referencing any of them, or the
 * drop of a parent is refused.
 */
const setAside = async (tables: readonly string[]): Promise<SetAside[]> => {
  const saved: SetAside[] = [];
  try {
    for (const table of tables) {
      const created = await db.row(`SHOW CREATE TABLE \`${table}\``);
      const ddl = String(created?.['Create Table'] ?? '');
      if (!ddl.startsWith('CREATE TABLE')) throw new Error(`no SHOW CREATE TABLE for ${table}`);
      const writable = (
        await db.rows(
          'SELECT `COLUMN_NAME` AS `name` FROM information_schema.COLUMNS ' +
            'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? ' +
            "AND `EXTRA` NOT LIKE '%GENERATED%' ORDER BY `ORDINAL_POSITION`",
          [table]
        )
      ).map((r) => String(r.name));
      const next = await db.row(
        'SELECT `AUTO_INCREMENT` AS `next` FROM information_schema.TABLES ' +
          'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ?',
        [table]
      );
      const autoIncrement = next?.next == null ? null : Number(next.next);
      const shape = await shapeOf(table);
      const backup = unique('bak');
      await db.exec(`CREATE TABLE \`${backup}\` AS SELECT * FROM \`${table}\``);
      saved.push({ table, ddl, backup, writable, autoIncrement, shape });
    }
  } catch (error) {
    for (const { backup } of saved) await db.exec(`DROP TABLE IF EXISTS \`${backup}\``);
    throw error;
  }
  for (const { table } of [...saved].reverse()) await db.exec(`DROP TABLE \`${table}\``);
  return saved;
};

/**
 * Put every table back as it was found, rows, ids and next id included, whatever state the
 * scenario left it in: created by apply, or still missing, in which case the first start's own
 * DDL makes it. Each step is tried whatever the one before did, and every failure is returned,
 * so one table that will not come back does not strand the rest.
 */
const putBack = async (saved: readonly SetAside[]): Promise<string[]> => {
  const problems: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const { table, ddl } of saved) {
    await attempt(`recreate ${table}`, async () => {
      if (!(await tableExists(table))) await db.exec(ddl);
    });
  }
  for (const { table } of [...saved].reverse()) {
    await attempt(`clear ${table}`, () => db.exec(`DELETE FROM \`${table}\``));
  }
  for (const { table, backup, writable, autoIncrement } of saved) {
    const list = writable.map((column) => `\`${column}\``).join(', ');
    await attempt(`restore ${table}'s rows`, async () => {
      await db.exec(`INSERT INTO \`${table}\` (${list}) SELECT ${list} FROM \`${backup}\``);
      if (autoIncrement !== null) {
        await db.exec(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${autoIncrement}`);
      }
      await db.exec(`DROP TABLE \`${backup}\``);
    });
  }
  return problems;
};

/**
 * Run `body` with `tables` dropped, and put them back afterwards however it ended. A failure to
 * put them back fails the scenario, and is named beside the scenario's own failure, never over it.
 */
const withTablesDropped = async (
  tables: readonly string[],
  body: (saved: readonly SetAside[]) => Promise<void>
): Promise<void> => {
  const saved = await setAside(tables);
  let failure: unknown = null;
  try {
    await body(saved);
  } catch (error) {
    failure = error;
  } finally {
    const problems = await putBack(saved);
    if (problems.length > 0) {
      const why = failure instanceof Error ? `${failure.message}; and ` : '';
      failure = new Error(`${why}putting the tables back failed: ${problems.join(' | ')}`);
    }
  }
  if (failure !== null) throw failure;
};

/** Every migration id in the ledger looks like this; the markers sharing it do not. */
const MIGRATION_ID = '^[0-9]{4}_';

/** What `micaschema apply` prints when it changed something, or could not. */
const APPLY_CHANGED = /^\[mica\] (applied migration|dropped|create table|add )/;
const APPLY_FAILED =
  /^\[mica\] (migration .* failed|.* failed: |not attempted|additive changes were not applied|could not drop)/;

export const schemaScenarios: Scenario[] = [
  {
    // MICA-306: the schema this run reads was made by micaOS's own first start, on a database
    // the wrapper left empty — and it finished, which the ledger's seed (written last) shows.
    id: 'schema-created-by-first-start-without-import',
    mode: 'standalone',
    tickets: ['MICA-306'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const mode = GetConvar('mica_integration_schema', '');
      if (mode !== 'bootstrap') {
        throw new Error(
          `mica_integration_schema is '${mode}', not 'bootstrap': this run was not set up to ` +
            'start micaOS on an empty database. The wrapper on the box predates MICA-306 (it ' +
            'imports mica.esx.sql first, so the first-start schema is unproven here); ' +
            'reinstall scripts/deploy/mica-smoke-release.sh as scripts/deploy/README.md says.'
        );
      }

      // The seed is the bootstrap's last statement, so a ledger with rows is a create that
      // reached its end. Until then the table may not exist yet, which is not an answer.
      await eventually(
        async () => {
          try {
            const rows = await db.count('SELECT COUNT(*) FROM `mica_schema_migrations`');
            return rows > 0 ? rows : null;
          } catch {
            return null;
          }
        },
        30_000,
        signal,
        'the first-start bootstrap to seed the migrations ledger'
      );

      const expected = seededMigrations(shippedSql());
      if (expected.length === 0) throw new Error('the shipped file seeds no migration id');
      const migrations = (await ledgerIds()).filter((id) => !NOT_A_MIGRATION.test(id));
      if (JSON.stringify(migrations) !== JSON.stringify(expected)) {
        throw new Error(
          `the ledger the bootstrap seeded is not the shipped list: has ${migrations.join(', ')}; ` +
            `expected ${expected.join(', ')}`
        );
      }

      // Standalone is the ESX shape: citizenid 60 wide, sized by the framework the bootstrap
      // detected, not defaulted. The audit log is one of the tables no declaration owns.
      const width = await db.row(
        'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mica_audit_logs' " +
          "AND `COLUMN_NAME` = 'citizenid'"
      );
      if (width?.type !== 'varchar(60)') {
        throw new Error(
          `mica_audit_logs.citizenid is ${String(width?.type)}; standalone takes the ESX width, varchar(60)`
        );
      }

      const tap = requireTap();
      const refused = tap.since(0).filter((line) => BOOTSTRAP_REFUSED.test(line));
      if (refused.length > 0) {
        throw new Error(`micaOS refused to create the schema: ${refused.join(' | ')}`);
      }
    }
  },
  {
    // MICA-289 (the ESX/standalone file), MICA-301: every table the declarations generate is
    // in the database the shipped file was imported into.
    id: 'schema-every-shipped-table-exists',
    mode: 'standalone',
    tickets: ['MICA-289', 'MICA-301'],
    run: async () => {
      const expected = shippedTables(shippedSql());
      if (expected.length < 20) {
        throw new Error(`the shipped file names only ${expected.length} tables`);
      }
      const live = new Set(
        (
          await db.rows(
            'SELECT `TABLE_NAME` AS `name` FROM information_schema.TABLES ' +
              'WHERE `TABLE_SCHEMA` = DATABASE()'
          )
        ).map((r) => String(r.name))
      );
      const missing = expected.filter((table) => !live.has(table));
      if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);
    }
  },
  {
    // MICA-301: the ledger holds every migration the shipped file seeds, once each, and
    // nothing else but the markers that share it on purpose.
    id: 'schema-migrations-ledger-seeded-and-consistent',
    mode: 'standalone',
    tickets: ['MICA-301'],
    run: async () => {
      const seeded = seededMigrations(shippedSql());
      if (seeded.length === 0) throw new Error('the shipped file seeds no migration id');
      const ids = await ledgerIds();
      const missing = seeded.filter((id) => !ids.includes(id));
      if (missing.length > 0) throw new Error(`not in the ledger: ${missing.join(', ')}`);
      const stray = ids.filter((id) => !seeded.includes(id) && !NOT_A_MIGRATION.test(id));
      if (stray.length > 0) {
        throw new Error(`in the ledger, neither seeded nor a known marker: ${stray.join(', ')}`);
      }
      const sorted = [...seeded].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(seeded)) {
        throw new Error('the shipped seed is not in apply order');
      }
    }
  },
  {
    // MICA-301, MICA-300, MICA-289: on a fresh import, `micaschema` reports nothing to do and
    // `micaschema apply` (console only) applies nothing — no migration re-run against tables
    // already in their new shape, no foreign key to drop, no additive column or index.
    id: 'schema-micaschema-report-and-apply-clean-on-fresh-import',
    mode: 'standalone',
    tickets: ['MICA-301', 'MICA-300', 'MICA-289'],
    timeoutMs: 40_000,
    run: async (signal) => {
      const tap = requireTap();
      const before = await ledgerIds();

      let mark = tap.mark();
      await runCommand('micaschema');
      await tap.waitFor(
        mark,
        /^\[mica\] schema is up to date\.$/,
        15_000,
        signal,
        "'[mica] schema is up to date.' from micaschema"
      );

      mark = tap.mark();
      await runCommand('micaschema apply');
      await tap.waitFor(
        mark,
        /^\[mica\] schema is already up to date\.$/,
        20_000,
        signal,
        "'[mica] schema is already up to date.' from micaschema apply"
      );
      await sleep(500);
      // A create and an added column or index are changes too (MICA-388): apply prints its
      // "already up to date" line only when nothing ran, but a filter blind to them is no check.
      const changed = tap
        .since(mark)
        .filter((line) => APPLY_CHANGED.test(line) || APPLY_FAILED.test(line));
      if (changed.length > 0) throw new Error(`apply changed something: ${changed.join(' | ')}`);

      const after = await ledgerIds();
      const migrationsOnly = (ids: string[]) => ids.filter((id) => !NOT_A_MIGRATION.test(id));
      if (JSON.stringify(migrationsOnly(before)) !== JSON.stringify(migrationsOnly(after))) {
        throw new Error('micaschema apply changed the migrations recorded in the ledger');
      }
    }
  },
  {
    // MICA-388: a table that is not there is a create, not "up to date". Dark Chat's three
    // tables are a parent, a child and a grandchild referencing both, so the creates only land
    // in foreign-key order. Each comes back as the first start made it, at the width in use,
    // and a second apply finds nothing. The rows, ids and next ids go back afterwards.
    id: 'schema-micaschema-apply-creates-missing-tables-in-key-order',
    mode: 'standalone',
    tickets: ['MICA-388'],
    timeoutMs: 30_000,
    run: async (signal) => {
      const tap = requireTap();
      const sql = shippedSql();
      const tables = ['mica_darkchat', 'mica_darkchat_members', 'mica_darkchat_messages'];
      const ledgerBefore = await ledgerIds();

      await withTablesDropped(tables, async (saved) => {
        for (const table of tables) {
          if (await tableExists(table)) throw new Error(`${table} is still there after the drop`);
        }

        let mark = tap.mark();
        await runCommand('micaschema');
        await tap.waitFor(
          mark,
          /^\[mica\] schema differences:$/,
          8_000,
          signal,
          "'[mica] schema differences:' from micaschema"
        );
        for (const table of tables) {
          const line = new RegExp(`^\\s+create table ${table} \\(it does not exist\\)$`);
          await tap.waitFor(mark, line, 3_000, signal, `micaschema listing ${table} to create`);
        }
        if (tap.since(mark).some((line) => /schema is up to date/.test(line))) {
          throw new Error('micaschema said the schema is up to date with three tables missing');
        }
        for (const table of tables) {
          if (await tableExists(table)) throw new Error(`micaschema (a dry run) created ${table}`);
        }

        mark = tap.mark();
        await runCommand('micaschema apply');
        const created: number[] = [];
        for (const table of tables) {
          await tap.waitFor(
            mark,
            new RegExp(`^\\[mica\\] create table ${table}$`),
            10_000,
            signal,
            `'[mica] create table ${table}' from micaschema apply`
          );
          created.push(
            tap.since(mark).findIndex((line) => line === `[mica] create table ${table}`)
          );
        }
        await sleep(500);
        const failed = tap.since(mark).filter((line) => APPLY_FAILED.test(line));
        if (failed.length > 0) throw new Error(`micaschema apply failed: ${failed.join(' | ')}`);
        if (created.some((at, i) => i > 0 && at < created[i - 1])) {
          throw new Error(`apply created ${tables.join(', ')} out of foreign-key order`);
        }

        // The database, not the console: each table is the one the first start made, and what
        // the shipped file declares, at the citizenid width every other table runs at.
        const shapes: string[][] = [];
        for (const { table, shape } of saved) {
          const now = await shapeOf(table);
          expectSameShape(table, shape, now, 'after micaschema apply');
          await expectShippedShape(sql, table);
          await expectCitizenidWidth(table);
          shapes.push(now);
        }

        mark = tap.mark();
        await runCommand('micaschema apply');
        await tap.waitFor(
          mark,
          /^\[mica\] schema is already up to date\.$/,
          10_000,
          signal,
          "'[mica] schema is already up to date.' from a second micaschema apply"
        );
        await sleep(500);
        const changed = tap
          .since(mark)
          .filter((line) => APPLY_CHANGED.test(line) || APPLY_FAILED.test(line));
        if (changed.length > 0) {
          throw new Error(`a second apply changed something: ${changed.join(' | ')}`);
        }
        for (const [i, table] of tables.entries()) {
          expectSameShape(table, shapes[i], await shapeOf(table), 'after a second apply');
        }
      });

      if (JSON.stringify(await ledgerIds()) !== JSON.stringify(ledgerBefore)) {
        throw new Error('creating the missing tables changed the migrations ledger');
      }
    }
  },
  {
    // MICA-389: on a ledger with no migration recorded — a first-start create that stopped
    // before the ledger's seed — and 0001's and 0003's tables missing, apply runs every
    // migration, 0001 and 0003 skip the table they would alter, each still records itself,
    // and the create pass builds both tables in their current shape. The ledger's markers
    // (MICA-165, MICA-167) are not migrations and stay; the migration rows go back as they were.
    id: 'schema-micaschema-apply-finishes-with-0001-and-0003-tables-missing',
    mode: 'standalone',
    tickets: ['MICA-389', 'MICA-388'],
    timeoutMs: 30_000,
    run: async (signal) => {
      const tap = requireTap();
      const sql = shippedSql();
      const tables = ['mica_phone_numbers', 'mica_battery'];
      const recorded = (await ledgerIds()).filter((id) => new RegExp(MIGRATION_ID).test(id));
      const seeded = seededMigrations(sql);
      for (const id of ['0001_phone_numbers_follow_the_phone', '0003_battery_follows_the_phone']) {
        if (!seeded.includes(id)) throw new Error(`the shipped file no longer seeds ${id}`);
      }
      if (recorded.length === 0) throw new Error('the ledger records no migration to clear');

      const ledgerCopy = unique('ledger');
      // The pattern is a constant written into the DDL, not a bound parameter: a create is
      // not a statement every driver will prepare.
      await db.exec(
        `CREATE TABLE \`${ledgerCopy}\` AS SELECT * FROM \`mica_schema_migrations\` ` +
          `WHERE \`id\` REGEXP '${MIGRATION_ID}'`
      );
      let failure: unknown = null;
      try {
        await withTablesDropped(tables, async (saved) => {
          await db.exec('DELETE FROM `mica_schema_migrations` WHERE `id` REGEXP ?', [MIGRATION_ID]);

          const mark = tap.mark();
          await runCommand('micaschema apply');
          for (const table of tables) {
            await tap.waitFor(
              mark,
              new RegExp(`^\\[mica\\] create table ${table}$`),
              15_000,
              signal,
              `'[mica] create table ${table}' from micaschema apply on an empty ledger`
            );
          }
          await sleep(500);
          const said = tap.since(mark);
          const failed = said.filter((line) => APPLY_FAILED.test(line));
          if (failed.length > 0) {
            throw new Error(`micaschema apply failed: ${failed.join(' | ')}`);
          }
          for (const id of recorded) {
            if (!said.includes(`[mica] applied migration ${id}`)) {
              throw new Error(`apply did not say it applied ${id}; said ${said.join(' | ')}`);
            }
          }

          // The ledger and the tables themselves, not the console's word for them.
          const ledger = (await ledgerIds()).filter((id) => new RegExp(MIGRATION_ID).test(id));
          if (JSON.stringify(ledger) !== JSON.stringify(recorded)) {
            throw new Error(
              `the ledger after apply records ${ledger.join(', ') || 'nothing'}; ` +
                `expected ${recorded.join(', ')}`
            );
          }
          for (const { table, shape } of saved) {
            expectSameShape(table, shape, await shapeOf(table), 'after apply on an empty ledger');
            await expectShippedShape(sql, table);
            await expectCitizenidWidth(table);
          }
        });
      } catch (error) {
        failure = error;
      } finally {
        // The ledger exactly as found, applied_at included, whatever apply recorded or did not.
        try {
          await db.exec('DELETE FROM `mica_schema_migrations` WHERE `id` REGEXP ?', [MIGRATION_ID]);
          await db.exec(
            'INSERT INTO `mica_schema_migrations` (`id`, `applied_at`) ' +
              `SELECT \`id\`, \`applied_at\` FROM \`${ledgerCopy}\``
          );
          await db.exec(`DROP TABLE \`${ledgerCopy}\``);
        } catch (error) {
          const why = failure instanceof Error ? `${failure.message}; and ` : '';
          const how = error instanceof Error ? error.message : String(error);
          failure = new Error(`${why}restoring the migrations ledger failed: ${how}`);
        }
      }
      if (failure !== null) throw failure;
    }
  }
];
