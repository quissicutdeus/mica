// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  declaredServices,
  normalizeIndex,
  type ChildTableDefinition,
  type ColumnDef,
  type ColumnType,
  type ResolvedService,
  type ResolvedIndex
} from './defineService';
import { citizenIdWidth } from '@mica/shared/framework';
import { AUDIT_LOG_TABLE } from './AuditLogger';
import { migrations as shippedMigrations } from '../migrations';

/**
 * Emit MySQL DDL from a resolved app schema.
 *
 * Two readers, one source. `scripts/generate-sql.js` writes `mica.sql` and `mica.esx.sql` from
 * it, for an owner who imports by hand; and `schemaBootstrap.ts` runs it once, on the first
 * start of a database that holds no micaOS table at all (MICA-306), so a fresh install needs
 * no import. Both go through `createStatements` below, so the two cannot describe different
 * schemas, and `generatedSchema.test.ts` holds the committed files to it.
 *
 * **Nothing here ever runs against a database that already has a micaOS table.** The files
 * use `CREATE TABLE IF NOT EXISTS`, which silently does nothing to a table that is there, so a
 * schema change applied that way would be a no-op with no error — the same silent-failure
 * shape that produced the dead NUI endpoints. A live table is brought up to date by
 * `micaschema apply` (AGENTS.md §8), never by re-running this. The first-start path uses plain
 * `CREATE TABLE` instead (`plainCreate`), so a table that unexpectedly exists is an error that
 * stops it rather than a statement that quietly skipped.
 *
 * `schemaMigrationsLedgerDdl` is also run by `server/lib/migrations.ts` with `IF NOT EXISTS`:
 * that table has a single fixed shape and never gains a column, so it cannot hide a change.
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
  /**
   * Plain `CREATE TABLE`, without `IF NOT EXISTS` (MICA-306). The first-start bootstrap's
   * form: a table that already exists there is a fault to stop on, never a statement to skip.
   * Off by default, which is the generated files' form.
   */
  plainCreate?: boolean;
}

/** `CREATE TABLE [IF NOT EXISTS] \`table\` (`, the first line of every table here. */
const createTableHead = (table: string, options: Pick<SchemaSqlOptions, 'plainCreate'>): string =>
  `CREATE TABLE ${options.plainCreate ? '' : 'IF NOT EXISTS '}\`${table}\` (`;

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
    createTableHead(table, options),
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
    createTableHead(child.name, options),
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
 * it — like the moderation audit ledger (`auditLogDdl`), it is
 * infrastructure rather than an app table, so it does not fit the app-table shape
 * `expectedShape` produces.
 */
export const SCHEMA_MIGRATIONS_TABLE = 'mica_schema_migrations';

export const schemaMigrationsLedgerDdl = (
  options: Pick<SchemaSqlOptions, 'plainCreate'> = {}
): string =>
  [
    createTableHead(SCHEMA_MIGRATIONS_TABLE, options),
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
 * **Does this database hold no micaOS table at all?** One SQL expression, 1 or 0, and the one
 * definition of "fresh" both paths share (MICA-306): the generated files' seed (MICA-301) and
 * the first-start bootstrap (`schemaBootstrap.ts`). Two predicates that could disagree would
 * let the import and the runtime path seed the ledger under different conditions.
 *
 * Any `mica_` table at all counts, not just the ledger: an install older than the ledger has
 * tables and no ledger, and is exactly the database whose migrations must run. `ESCAPE '|'`
 * makes the underscore literal; unescaped it is a single-character wildcard.
 */
export const FRESH_DATABASE_PREDICATE =
  '(SELECT COUNT(*) = 0 FROM information_schema.TABLES\n' +
  "    WHERE table_schema = DATABASE() AND table_name LIKE 'mica|_%' ESCAPE '|')";

/**
 * The first statement of a generated file's schema (MICA-301): does this database hold any
 * micaOS table yet?
 *
 * Asked before anything is created, because afterwards every table exists whichever way the
 * import went — every `CREATE` is `IF NOT EXISTS`, the ledger's own included, so no later
 * statement can tell a fresh install from a re-import.
 */
export const freshImportProbeSql = (): string =>
  [
    '-- Is this import creating micaOS from nothing? Asked before the first CREATE TABLE: the',
    '-- migrations ledger below is seeded only then (MICA-301).',
    `SET ${FRESH_IMPORT} = ${FRESH_DATABASE_PREDICATE};`
  ].join('\n');

/**
 * The same question at run time, as a single-value read (MICA-306). Not the session variable:
 * oxmysql hands each query whichever pooled connection is free, so a `SET @…` in one statement
 * is not visible to the next, and the bootstrap carries the answer in TypeScript instead.
 */
export const freshDatabaseProbeSql = (): string =>
  `SELECT ${FRESH_DATABASE_PREDICATE} AS \`fresh\``;

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

/**
 * The first-start seed (MICA-306): every shipped migration id, recorded as applied without
 * running `up()`, because every table was just created in its final shape.
 *
 * Unconditional, unlike `schemaMigrationsSeedSql`: the bootstrap runs it only after creating
 * every table itself, so the freshness question was answered in TypeScript before the first
 * `CREATE`. `INSERT IGNORE` all the same, so it can never fail on an id already present.
 */
export const schemaMigrationsRuntimeSeedSql = (ids: readonly string[]): string | null => {
  if (ids.length === 0) return null;
  const rows = ids.map((id) => `    ('${id.replace(/'/g, "''")}')`);
  return [
    `INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES`,
    `${rows.join(',\n')};`
  ].join('\n');
};

/**
 * The values `mica_audit_logs.action` accepts. An ENUM, so **adding one is a schema change**:
 * a versioned migration that widens it, the matching member of `AuditAction` in
 * `AuditLogger.ts`, and a CHANGELOG "Action required" entry. `test:schema` is the only suite
 * that would see an insert outside it; the `Database` stub accepts any string.
 */
export const AUDIT_LOG_ACTIONS = [
  'archived',
  'unarchived',
  'deleted',
  'left',
  'removed',
  'moderated',
  'unmoderated',
  'viewed'
] as const;

/**
 * The central moderation and accountability ledger, `mica_audit_logs` — a code constant since
 * MICA-306 retired `scripts/framework-schema.sql`, the last hand-written table definition.
 *
 * Every destructive or state-changing action a player takes on their own content is recorded
 * here by `AuditLogger.ts`: deletions, archives, leaving or being removed from a conversation,
 * and moderation. It is append-only — nothing in micaOS updates or deletes a row in it — so it
 * stays a trustworthy record after the content it refers to has been soft-deleted.
 *
 * One action, `viewed`, is not a player acting on their own content at all: it is an admin
 * reading content somebody else reported (MICA-70). It is the one exception to
 * "state-changing" above, and it exists for the same reason the rest of the table does — a read
 * otherwise leaves nothing behind for anyone to be held accountable to.
 *
 * `target_table` + `target_id` point at the affected row rather than using a foreign key, on
 * purpose: the log must survive the row it describes, and it spans every app table. Nor is
 * there one on `citizenid` (MICA-300): it used to reference qb's `players` with ON DELETE
 * CASCADE, which deleted a character's rows inside MariaDB before any report hold could apply;
 * the character-deleted purge and the orphan sweep (`orphanSweep.ts`) clean up now.
 *
 * No `defineService` behind it: no owning service, and it does not fit the app-table shape (no
 * `status`, no `updated_at`). `citizenid` is sized like every declared table's, by
 * `citizenIdWidth` — 50 on qb, 60 on ESX and standalone (MICA-289) — where the hand-written
 * file was written at 50 and widened for ESX by a text substitution in the generator.
 */
export const auditLogDdl = (options: SchemaSqlOptions = {}): string =>
  [
    createTableHead(AUDIT_LOG_TABLE, options),
    '    `id` int(11) NOT NULL AUTO_INCREMENT,',
    `    \`citizenid\` varchar(${citizenIdWidth(options.ownerTable !== false)}) NOT NULL,`,
    '    `action` ENUM(',
    AUDIT_LOG_ACTIONS.map((action) => `        '${action}'`).join(',\n'),
    '    ) NOT NULL,',
    '    `service` varchar(100) NOT NULL,',
    '    `method` varchar(100) NOT NULL,',
    '    `target_id` int(11) NOT NULL,',
    '    `target_table` varchar(100) DEFAULT NULL,',
    '    `details` text DEFAULT NULL,',
    '    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    PRIMARY KEY (`id`),',
    '    KEY `citizenid` (`citizenid`),',
    '    KEY `action` (`action`),',
    '    KEY `service_method` (`service`, `method`),',
    '    KEY `target` (`target_table`, `target_id`),',
    '    -- Moderation review reads newest-first for one player.',
    '    KEY `citizenid_created` (`citizenid`, `created_at`)',
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = ${TABLE_COLLATION};`
  ].join('\n');

/** Every table a service references by foreign key. */
const referencedTables = (app: ResolvedService): string[] => {
  const refs: string[] = [];
  for (const { def } of app.fields) {
    if (def.references) refs.push(def.references.table);
  }
  for (const child of app.childTables) {
    for (const spec of Object.values(child.columns)) {
      const ref = typeof spec === 'string' ? undefined : spec.references;
      if (ref) refs.push(ref.table);
    }
  }
  return refs;
};

/**
 * Order apps so every table's foreign-key targets already exist when it is created.
 *
 * Cross-app foreign keys make this necessary: nothing guarantees a table's dependencies sort
 * earlier than it does alphabetically, and a clean database fails with errno 150 the moment
 * one doesn't. The generated files and the first-start bootstrap both create in this order.
 *
 * Kahn's algorithm, alphabetical within a dependency level so output is stable. Throws on a
 * cycle, which no order can satisfy.
 */
export function orderAppsByDependency(apps: readonly ResolvedService[]): ResolvedService[] {
  const ownerOf = new Map<string, string>();
  for (const app of apps) {
    ownerOf.set(app.table, app.id);
    for (const child of app.childTables) ownerOf.set(child.name, app.id);
  }

  // dependsOn: app id -> the app ids that must be created first.
  const dependsOn = new Map<string, Set<string>>(apps.map((a) => [a.id, new Set<string>()]));
  for (const app of apps) {
    for (const table of referencedTables(app)) {
      const owner = ownerOf.get(table);
      // Unowned targets are external (e.g. `players`) — not this ordering's problem.
      if (owner && owner !== app.id) dependsOn.get(app.id)?.add(owner);
    }
  }

  const ordered: ResolvedService[] = [];
  const remaining = [...apps].sort((a, b) => a.id.localeCompare(b.id));

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((app) =>
      [...(dependsOn.get(app.id) ?? [])].every((dep) => ordered.some((done) => done.id === dep))
    );

    if (readyIndex === -1) {
      const stuck = remaining.map((a) => a.id).join(', ');
      throw new Error(
        `generate-sql: circular foreign-key dependency between apps: ${stuck}. ` +
          'No apply order can satisfy these constraints.'
      );
    }
    ordered.push(...remaining.splice(readyIndex, 1));
  }

  return ordered;
}

/** The migration ids this build ships, from the generated barrel, in apply order. */
export const shippedMigrationIds = (): string[] =>
  shippedMigrations.map((m) => m.id).sort((a, b) => a.localeCompare(b));

/**
 * Every table the first-start bootstrap creates, in the order it creates them — the order
 * `createStatements` runs them in.
 */
export const bootstrapTables = (): string[] => [
  SCHEMA_MIGRATIONS_TABLE,
  AUDIT_LOG_TABLE,
  ...orderAppsByDependency(declaredServices).flatMap((app) => [
    app.table,
    ...app.childTables.map((child) => child.name)
  ])
];

/**
 * The whole schema as statements to run one at a time, for a database that holds no micaOS
 * table (MICA-306). Plain `CREATE TABLE` throughout, never `IF NOT EXISTS`.
 *
 * The order is load-bearing:
 *
 * 1. **The migrations ledger first, because creating it is the claim.** Two servers starting
 *    on one fresh database both see it fresh; the plain `CREATE` lets exactly one of them
 *    create the ledger, and the other gets errno 1050 before it has created anything.
 * 2. The audit log, which nothing references.
 * 3. Each app's table, then its child tables in declaration order, apps in dependency order so
 *    every foreign key's target exists first (`orderAppsByDependency`).
 * 4. **The seed last**, so a create that stops part-way leaves an empty ledger beside missing
 *    tables — the half-created state the bootstrap reports and never resumes — and never a
 *    ledger saying the migrations ran over a schema that is not there.
 *
 * `ownerTable` sizes every `citizenid` column, as it does for the generated files.
 */
export function createStatements(ownerTable: boolean): string[] {
  const options: SchemaSqlOptions = { ownerTable, plainCreate: true };
  const seed = schemaMigrationsRuntimeSeedSql(shippedMigrationIds());
  return [
    schemaMigrationsLedgerDdl(options),
    auditLogDdl(options),
    ...orderAppsByDependency(declaredServices).flatMap((app) => [
      toCreateTableSql(app, options),
      ...app.childTables.map((child) => toChildTableSql(child, options))
    ]),
    ...(seed ? [seed] : [])
  ];
}
