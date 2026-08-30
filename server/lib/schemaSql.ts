import {
  normalizeIndex,
  type ChildTableDefinition,
  type ColumnDef,
  type ColumnType,
  type ResolvedService,
  type ResolvedIndex
} from './defineService';
import { CITIZENID_MAX_LENGTH } from '@shared/framework';

/**
 * Emit MySQL DDL from a resolved app schema.
 *
 * No app table's `CREATE TABLE` is ever executed at runtime. `CREATE TABLE IF NOT EXISTS`
 * silently does nothing when the table already exists, so a schema change applied that way
 * would be a no-op with no error — the same silent-failure shape that produced the dead NUI
 * endpoints. Output goes to a reviewable file instead, and a live table is brought up to date
 * by `gphoneschema apply` (AGENTS.md §8) rather than by re-running this.
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

const columnSql = (name: string, def: ColumnDef): string => {
  const type = SQL_TYPES[def.type];
  if (!type) {
    throw new Error(`schemaSql: unknown column type '${def.type}' on '${name}'.`);
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
 * The framework's own player table, which gPhone references but does not create.
 *
 * qb owns `players(citizenid)`. ESX has no such table — it has `users(identifier)` — so on a
 * pure `es_extended` server every constraint pointing here fails at import.
 */
export const OWNER_TABLE = 'players';

/**
 * The collation every gPhone-owned table is created with, on both generated files.
 *
 * A single named constant rather than the literal repeated at each `CREATE TABLE`'s closing
 * line, because `collationCheck.ts` (MICA-157) needs the exact same value a live
 * `players.citizenid` is compared against: a foreign key requires both sides of the
 * relationship to share a collation, and MariaDB 11.4+ changed its own `utf8mb4` default away
 * from this one, which is what makes the comparison worth having at all.
 */
export const TABLE_COLLATION = 'utf8mb4_unicode_ci';

/**
 * How much of the schema the framework underneath can support.
 *
 * The only axis so far is whether `players(citizenid)` exists, and it is expressed as an
 * option rather than read from `FrameworkBridge` because this module runs in two places:
 * inside the resource, and inside `scripts/generate-sql.js` under node, where there is no
 * framework to ask. The generator decides; this only renders what it is told.
 *
 * **Defaults to the qb answer**, so every existing call site emits exactly the bytes it
 * emitted before ESX was a thing. That is deliberate: the committed `gphone.sql` is the
 * artifact server owners import by hand, and the ESX support is provably additive only if
 * that file does not move.
 */
export interface SchemaSqlOptions {
  /**
   * Does this server have a `players(citizenid)` table for gPhone's rows to hang off?
   *
   * `false` omits every foreign key targeting it — the implicit `citizenid` one on each app
   * table, and the three child tables that declare it explicitly (`Marketplace`, `Messages`,
   * `Conversations`). **It omits the `ON DELETE CASCADE` with them**, which is the real cost
   * of the option and not a detail: on qb, deleting a character removes their rows from 22
   * tables for free, and on ESX nothing does. That gap is its own ticket, and the constraint
   * cannot simply be kept — a schema that will not import is not a safer one.
   */
  ownerTable?: boolean;
}

const foreignKeySql = (
  table: string,
  column: string,
  def: ColumnDef,
  options: SchemaSqlOptions = {}
): string | null => {
  if (!def.references) return null;
  const { table: refTable, column: refColumn, onDelete = 'CASCADE' } = def.references;
  if (refTable === OWNER_TABLE && options.ownerTable === false) return null;
  return (
    `    CONSTRAINT \`fk_${table}_${column}\` FOREIGN KEY (\`${column}\`)\n` +
    `        REFERENCES \`${refTable}\` (\`${refColumn}\`) ON DELETE ${onDelete},`
  );
};

/**
 * Strip the trailing comma a `CREATE TABLE` body's last line always carries.
 *
 * Every line emitter above ends its line with `,` because something normally follows.
 * Dropping the owner foreign key can leave nothing following, and MySQL rejects a body that
 * ends in a comma — a failure that only ever appears on a fresh ESX install, which is exactly
 * the audience this branch exists for.
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
      // Width from `@shared/framework`, not a literal: the same constant bounds the
      // identifier that lands here, so the column and its guard cannot drift apart
      // (MICA-158).
      {
        name: 'citizenid',
        def: { type: 'string', length: CITIZENID_MAX_LENGTH, notNull: true }
      },
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
export const columnDefinitionSql = (name: string, def: ColumnDef): string =>
  columnSql(name, def).trim();

/** A single `ADD [UNIQUE] KEY` fragment. */
export const indexDefinitionSql = (index: ResolvedIndex): string =>
  indexSql(index).trim().replace(/,$/, '');

/**
 * The full `CREATE TABLE` for an app's primary table, matching the conventions
 * already in gphone.sql: soft-delete `status` enum, citizenid FK onto `players` with
 * cascade, and a `(citizenid, status)` index because every generic read filters on
 * both.
 */
export function toCreateTableSql(
  resolved: ResolvedService,
  options: SchemaSqlOptions = {}
): string {
  const { table, id, fields } = resolved;
  const shape = expectedShape(resolved);

  const declaredForeignKeys = fields
    .map(({ name, def }) => foreignKeySql(table, name, def, options))
    .filter((line): line is string => line !== null);

  const ownerForeignKey =
    options.ownerTable === false
      ? []
      : [
          `    CONSTRAINT \`fk_${id}_citizenid\` FOREIGN KEY (\`citizenid\`)`,
          `        REFERENCES \`${OWNER_TABLE}\` (\`citizenid\`) ON DELETE CASCADE`
        ];

  const body = [
    '    `id` int(11) NOT NULL AUTO_INCREMENT,',
    ...shape.columns
      .filter((c) => !c.autoIncrement)
      .map(({ name, def }) => `${columnSql(name, def)},`),
    '    PRIMARY KEY (`id`),',
    ...shape.indexes.map(indexSql),
    ...declaredForeignKeys
  ];

  const lines = [
    `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
    // Only closed when the owner key is not following it. With the key present the body is
    // emitted exactly as it always was, comma and all, so the qb file does not move a byte.
    ...(ownerForeignKey.length > 0 ? body : closeBody(body)),
    ...ownerForeignKey,
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
    .map(([name, def]) => foreignKeySql(child.name, name, def, options))
    .filter((line): line is string => line !== null);

  const body = [
    ...(child.autoIncrementId === false ? [] : ['    `id` int(11) NOT NULL AUTO_INCREMENT,']),
    ...entries.map(([name, def]) => `${columnSql(name, def)},`),
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
export const SCHEMA_MIGRATIONS_TABLE = 'gphone_schema_migrations';

export const schemaMigrationsLedgerDdl = (): string =>
  [
    `CREATE TABLE IF NOT EXISTS \`${SCHEMA_MIGRATIONS_TABLE}\` (`,
    '    `id` varchar(255) NOT NULL,',
    '    `applied_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    PRIMARY KEY (`id`)',
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = ${TABLE_COLLATION};`
  ].join('\n');

/**
 * `INSERT IGNORE` seeding every migration id that exists as of generation time.
 *
 * A fresh install imports every table already in its final shape, so its migrations must
 * never actually run — each would find a table that was never in the shape it expects to
 * find it in. Seeding the ledger marks them applied without running `up()`. `INSERT IGNORE`
 * rather than `INSERT`: re-running `pnpm generate:sql` against a database that already has
 * some of these rows (e.g. a dev database that both imported an older `gphone.sql` and later
 * ran `gphoneschema apply`) must not error.
 */
export const schemaMigrationsSeedSql = (ids: readonly string[]): string | null => {
  if (ids.length === 0) return null;
  const values = ids.map((id) => `('${id.replace(/'/g, "''")}')`).join(',\n  ');
  return `INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES\n  ${values};`;
};
