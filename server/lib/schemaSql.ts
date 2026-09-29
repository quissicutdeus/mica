// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  normalizeIndex,
  type ChildTableDefinition,
  type ColumnDef,
  type ColumnType,
  type ResolvedService,
  type ResolvedIndex
} from './defineService';
import { citizenIdWidth } from '@mica/shared/framework';

/**
 * Emit MySQL DDL from a resolved app schema.
 *
 * No app table's `CREATE TABLE` is ever executed at runtime. `CREATE TABLE IF NOT EXISTS`
 * silently does nothing when the table already exists, so a schema change applied that way
 * would be a no-op with no error — the same silent-failure shape that produced the dead NUI
 * endpoints. Output goes to a reviewable file instead, and a live table is brought up to date
 * by `micaschema apply` (AGENTS.md §8) rather than by re-running this.
 *
 * `schemaMigrationsLedgerDdl` below is the one exception, and `server/lib/migrations.ts` does
 * run it: that table has a single fixed shape and never gains a column, so `IF NOT EXISTS`
 * cannot hide a change there.
 *
 * Kept separate from `defineService` so the FiveM server bundle does not carry
 * DDL-generation code it never calls — except that one function.
 */

const SQL_TYPES: Record<ColumnType, (def: ColumnDef) => string> = {
  string: (def) => `varchar(${def.length ?? 255})`,
  text: () => 'text',
  mediumtext: () => 'mediumtext',
  int: () => 'int(11)',
  // Single precision: GTA V world coordinates need sub-metre precision, not the ~15
  // significant digits `double` would give a value nothing computes further from —
  // `mica_places` (MICA-65) is the first column of this type.
  float: () => 'float',
  bool: () => 'tinyint(1)',
  json: () => 'longtext',
  blob: () => 'mediumblob',
  timestamp: () => 'timestamp',
  enum: (def) => {
    if (!def.values || def.values.length === 0) {
      throw new Error("schemaSql: type 'enum' requires a non-empty `values` list.");
    }
    return `ENUM(${def.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`;
  }
};

const sqlLiteral = (value: string | number | boolean | null): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
};

const normalize = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * A `citizenId` column's width for the file being written (MICA-289): qb's `players` key on qb,
 * `users.identifier`'s otherwise. Every other column as declared.
 */
const withOwnerWidth = (def: ColumnDef, options: SchemaSqlOptions): ColumnDef =>
  def.citizenId ? { ...def, length: citizenIdWidth(options.ownerTable !== false) } : def;

const columnSql = (name: string, declared: ColumnDef, options: SchemaSqlOptions = {}): string => {
  const def = withOwnerWidth(declared, options);
  const type = SQL_TYPES[def.type];
  if (!type) {
    throw new Error(`schemaSql: unknown column type '${def.type}' on '${name}'.`);
  }

  /**
   * A generated column's value comes entirely from the expression — no NOT NULL/DEFAULT/
   * ON UPDATE modifier below applies, and MySQL rejects several of them outright alongside
   * `GENERATED ALWAYS AS (...)`. VIRTUAL rather than STORED/PERSISTENT: nothing here needs
   * the value on disk, and both MySQL and MariaDB index a VIRTUAL column just as well.
   */
  if (def.generatedAs) {
    return `    \`${name}\` ${type(def)} GENERATED ALWAYS AS (${def.generatedAs}) VIRTUAL`;
  }

  const parts = [`\`${name}\``, type(def)];
  if (def.notNull) parts.push('NOT NULL');

  if (def.defaultNow) {
    parts.push('DEFAULT CURRENT_TIMESTAMP');
  } else if (def.default !== undefined) {
    parts.push(`DEFAULT ${sqlLiteral(def.default)}`);
  } else if (!def.notNull) {
    parts.push('DEFAULT NULL');
  }

  if (def.onUpdateNow) parts.push('ON UPDATE CURRENT_TIMESTAMP');

  return `    ${parts.join(' ')}`;
};

const indexSql = ({ name, columns, unique }: ResolvedIndex): string => {
  const list = columns.map((c) => `\`${c}\``).join(', ');
  return `    ${unique ? 'UNIQUE KEY' : 'KEY'} \`${name}\` (${list}),`;
};

/**
 * qb's player table, which micaOS reads but does not create — and, since MICA-300, never
 * references with a foreign key.
 *
 * Every micaOS table used to carry `REFERENCES players(citizenid) ON DELETE CASCADE`, so qb
 * deleting a character deleted their micaOS rows inside MariaDB, before any report hold or
 * cascade guard could apply: a reported post and its photo, and — through micaOS's own
 * cascades — another player's replies under it. `foreignKeySql` refuses such a reference now,
 * and the character-deleted purge and the orphan sweep decide instead (`orphanSweep.ts`).
 * Migration 0006 drops the constraints from an existing qb database.
 */
export const OWNER_TABLE = 'players';

/**
 * The collation every micaOS-owned table is created with, on both generated files.
 *
 * One named constant rather than the literal repeated at each `CREATE TABLE`'s closing line.
 * Nothing outside micaOS has to agree with it any more: the one comparison against a framework
 * column, the orphan sweep's, runs in that column's own collation (MICA-299), and the foreign
 * key onto `players` that once required a match is gone (MICA-300).
 */
export const TABLE_COLLATION = 'utf8mb4_unicode_ci';

/**
 * Which framework the file being written is for.
 *
 * The only axis is whether qb's `players(citizenid)` is the owner, and it is expressed as an
 * option rather than read from `FrameworkBridge` because this module runs in two places:
 * inside the resource, and inside `scripts/generate-sql.js` under node, where there is no
 * framework to ask. The generator decides; this only renders what it is told.
 */
export interface SchemaSqlOptions {
  /**
   * Is qb's `players(citizenid)` the owner? Defaults to yes, the `mica.sql` answer.
   *
   * It sizes every `citizenId` column (MICA-289) and nothing else. It used to decide whether
   * each table carried a foreign key onto `players` too; no table does since MICA-300.
   */
  ownerTable?: boolean;
}

const foreignKeySql = (table: string, column: string, def: ColumnDef): string | null => {
  if (!def.references) return null;
  const { table: refTable, column: refColumn, onDelete = 'CASCADE' } = def.references;
  if (refTable === OWNER_TABLE) {
    throw new Error(
      `schemaSql: ${table}.${column} references \`${OWNER_TABLE}\`. micaOS tables carry no ` +
        'foreign key onto the framework (MICA-300): its cascade deleted held evidence before ' +
        'any hold applied. Drop the reference; a `citizenid` column with `citizenId: true` is ' +
        "already how the purge and the sweep find a table's owner."
    );
  }
  return (
    `    CONSTRAINT \`fk_${table}_${column}\` FOREIGN KEY (\`${column}\`)\n` +
    `        REFERENCES \`${refTable}\` (\`${refColumn}\`) ON DELETE ${onDelete},`
  );
};

/**
 * Strip the trailing comma a `CREATE TABLE` body's last line always carries.
 *
 * Every line emitter above ends its line with `,` because something normally follows, and
 * MySQL rejects a body that ends in one.
 */
const closeBody = (body: readonly string[]): string[] => {
  if (body.length === 0) return [];
  const lines = [...body];
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  return lines;
};

/** One column of a table, as data rather than as a line of SQL. */
interface ExpectedColumn {
  name: string;
  def: ColumnDef;
  /** True for `id`. Never migrated: adding an auto-increment PK to a live table is
   *  not something to attempt unattended. */
  autoIncrement?: boolean;
}

export interface ExpectedShape {
  table: string;
  columns: ExpectedColumn[];
  indexes: ResolvedIndex[];
}

/**
 * What a table is supposed to look like, as data.
 *
 * Extracted so `toCreateTableSql` and the migration planner read the *same*
 * description. Previously the shape existed only as lines of SQL text inside the
 * creator, which meant a migrator would have had to restate it — and a restatement
 * that drifts is how you get a fresh install and an upgraded install with different
 * schemas.
 */
export function expectedShape(resolved: ResolvedService): ExpectedShape {
  const { table, statuses, fields, indexes } = resolved;

  const perColumnIndexes: ResolvedIndex[] = fields
    .filter(({ def }) => def.index)
    .map(({ name }) => ({
      name: `citizenid_${name}`,
      columns: ['citizenid', name],
      unique: false
    }));

  return {
    table,
    columns: [
      { name: 'id', def: { type: 'int', notNull: true }, autoIncrement: true },
      // `citizenId` rather than a length: its width is the owner key's, 50 on qb and 60 on
      // ESX, and the same `@mica/shared/framework` function sizes the column and bounds the
      // identifier that lands in it, so the two cannot drift apart (MICA-158, MICA-289).
      { name: 'citizenid', def: { type: 'string', citizenId: true, notNull: true } },
      ...fields.map(({ name, def }) => ({ name, def })),
      {
        name: 'status',
        def: { type: 'enum', values: statuses, notNull: true, default: 'active' }
      },
      { name: 'created_at', def: { type: 'timestamp', notNull: true, defaultNow: true } },
      {
        name: 'updated_at',
        def: { type: 'timestamp', notNull: true, defaultNow: true, onUpdateNow: true }
      }
    ],
    indexes: [
      { name: 'status', columns: ['status'], unique: false },
      { name: 'citizenid_status', columns: ['citizenid', 'status'], unique: false },
      ...perColumnIndexes,
      ...indexes.map(normalizeIndex)
    ]
  };
}

/** A single `ADD COLUMN` / column-definition fragment, without the CREATE TABLE indent. */
export const columnDefinitionSql = (
  name: string,
  def: ColumnDef,
  options: SchemaSqlOptions = {}
): string => columnSql(name, def, options).trim();

/** A single `ADD [UNIQUE] KEY` fragment. */
export const indexDefinitionSql = (index: ResolvedIndex): string =>
  indexSql(index).trim().replace(/,$/, '');

/**
 * The full `CREATE TABLE` for an app's primary table, matching the conventions
 * already in mica.sql: soft-delete `status` enum, and a `(citizenid, status)` index
 * because every generic read filters on both. No foreign key on `citizenid` (MICA-300).
 */
export function toCreateTableSql(
  resolved: ResolvedService,
  options: SchemaSqlOptions = {}
): string {
  const { table, fields } = resolved;
  const shape = expectedShape(resolved);

  const declaredForeignKeys = fields
    .map(({ name, def }) => foreignKeySql(table, name, def))
    .filter((line): line is string => line !== null);

  const body = [
    '    `id` int(11) NOT NULL AUTO_INCREMENT,',
    ...shape.columns
      .filter((c) => !c.autoIncrement)
      .map(({ name, def }) => `${columnSql(name, def, options)},`),
    '    PRIMARY KEY (`id`),',
    ...shape.indexes.map(indexSql),
    ...declaredForeignKeys
  ];

  const lines = [
    `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
    ...closeBody(body),
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = ${TABLE_COLLATION};`
  ];

  return lines.join('\n');
}

/**
 * A child table's `CREATE TABLE`. Nothing is implicit beyond an optional
 * auto-increment id — these tables disagree about whether they carry `status` or
 * timestamps, which is exactly why they cannot use the primary-table shape.
 */
export function toChildTableSql(
  child: ChildTableDefinition,
  options: SchemaSqlOptions = {}
): string {
  const entries = Object.entries(child.columns).map(
    ([name, spec]) => [name, normalize(spec)] as const
  );

  const foreignKeys = entries
    .map(([name, def]) => foreignKeySql(child.name, name, def))
    .filter((line): line is string => line !== null);

  const body = [
    ...(child.autoIncrementId === false ? [] : ['    `id` int(11) NOT NULL AUTO_INCREMENT,']),
    ...entries.map(([name, def]) => `${columnSql(name, def, options)},`),
    ...(child.autoIncrementId === false ? [] : ['    PRIMARY KEY (`id`),']),
    ...(child.indexes ?? []).map((i) => indexSql(normalizeIndex(i))),
    ...foreignKeys
  ];

  return [
    `CREATE TABLE IF NOT EXISTS \`${child.name}\` (`,
    // The last body line carries a trailing comma; strip it.
    ...closeBody(body),
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = ${TABLE_COLLATION};`
  ].join('\n');
}

/**
 * A generated file's contents: the primary table, then every child table in
 * declaration order so foreign keys resolve.
 */
export function toSqlFile(resolved: ResolvedService, options: SchemaSqlOptions = {}): string {
  const blocks = [
    toCreateTableSql(resolved, options),
    ...resolved.childTables.map((child) => toChildTableSql(child, options))
  ];

  return [
    `-- Generated from the '${resolved.id}' defineService declaration.`,
    '-- Do not edit by hand; change the declaration and regenerate.',
    '',
    blocks.join('\n\n'),
    ''
  ].join('\n');
}

/**
 * The ledger table versioned migrations record themselves into. No `defineService` behind
 * it — like the framework audit ledger in `scripts/framework-schema.sql`, it is
 * infrastructure rather than an app table, so it does not fit the app-table shape
 * `expectedShape` produces.
 */
export const SCHEMA_MIGRATIONS_TABLE = 'mica_schema_migrations';

export const schemaMigrationsLedgerDdl = (): string =>
  [
    `CREATE TABLE IF NOT EXISTS \`${SCHEMA_MIGRATIONS_TABLE}\` (`,
    '    `id` varchar(255) NOT NULL,',
    '    `applied_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    PRIMARY KEY (`id`)',
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = ${TABLE_COLLATION};`
  ].join('\n');

/**
 * The session variable a generated file records "this import found no micaOS table" in.
 * `freshImportProbeSql` sets it before the first `CREATE TABLE`; the seed reads it at the end.
 */
const FRESH_IMPORT = '@mica_fresh_import';

/**
 * The first statement of a generated file's schema (MICA-301): does this database hold any
 * micaOS table yet?
 *
 * Asked before anything is created, because afterwards every table exists whichever way the
 * import went — every `CREATE` is `IF NOT EXISTS`, the ledger's own included, so no later
 * statement can tell a fresh install from a re-import. Any `mica_` table at all counts, not
 * just the ledger: an install older than the ledger has tables and no ledger, and is exactly
 * the database whose migrations must run.
 */
export const freshImportProbeSql = (): string =>
  [
    '-- Is this import creating micaOS from nothing? Asked before the first CREATE TABLE: the',
    '-- migrations ledger below is seeded only then (MICA-301).',
    `SET ${FRESH_IMPORT} = (SELECT COUNT(*) = 0 FROM information_schema.TABLES`,
    "    WHERE table_schema = DATABASE() AND table_name LIKE 'mica|_%' ESCAPE '|');"
  ].join('\n');

/**
 * Seed every migration id that exists as of generation time — **only into a database this same
 * import created** (`freshImportProbeSql`).
 *
 * A fresh install imports every table already in its final shape, so its migrations must never
 * run; seeding the ledger marks them applied without running `up()`.
 *
 * Re-imported over an existing database it used to seed them all the same (MICA-301): every
 * table there is left as it was by `CREATE TABLE IF NOT EXISTS`, the ledger said the migrations
 * were done, and `micaschema apply` never ran them. So the seed reads what the probe found, and
 * an import over any existing micaOS table records nothing; apply then runs what that database
 * has not had, and every migration is written to find nothing to do where it already has.
 *
 * Fails toward running: a probe that did not run in the same session — statements pasted one by
 * one into different connections — leaves the variable NULL, and NULL seeds nothing.
 * `INSERT IGNORE` still, so a fresh database that already has some of these rows does not error.
 */
export const schemaMigrationsSeedSql = (ids: readonly string[]): string | null => {
  if (ids.length === 0) return null;
  const rows = ids.map((id, i) => {
    const literal = `'${id.replace(/'/g, "''")}'`;
    return i === 0 ? `    SELECT ${literal} AS \`id\`` : `    UNION ALL SELECT ${literal}`;
  });
  return [
    `INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`)`,
    'SELECT `id` FROM (',
    ...rows,
    `) AS \`seed\` WHERE ${FRESH_IMPORT} = 1;`
  ].join('\n');
};
