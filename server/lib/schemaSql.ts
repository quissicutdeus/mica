import {
  normalizeIndex,
  type ChildTableDefinition,
  type ColumnDef,
  type ColumnType,
  type ResolvedAppSchema,
  type ResolvedIndex
} from './defineServerApp';

/**
 * Emit MySQL DDL from a resolved app schema.
 *
 * Deliberately NOT executed at runtime. `CREATE TABLE IF NOT EXISTS` silently does
 * nothing when the table already exists, so a schema change to a live table would
 * be a no-op with no error — the same silent-failure shape that produced the dead
 * NUI endpoints. Output goes to a reviewable file instead; a real migration runner
 * consumes it later.
 *
 * Kept separate from `defineServerApp` so the FiveM server bundle does not carry
 * DDL-generation code it never calls.
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

const foreignKeySql = (table: string, column: string, def: ColumnDef): string | null => {
  if (!def.references) return null;
  const { table: refTable, column: refColumn, onDelete = 'CASCADE' } = def.references;
  return (
    `    CONSTRAINT \`fk_${table}_${column}\` FOREIGN KEY (\`${column}\`)\n` +
    `        REFERENCES \`${refTable}\` (\`${refColumn}\`) ON DELETE ${onDelete},`
  );
};

/** One column of a table, as data rather than as a line of SQL. */
export interface ExpectedColumn {
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
export function expectedShape(resolved: ResolvedAppSchema): ExpectedShape {
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
      { name: 'citizenid', def: { type: 'string', length: 50, notNull: true } },
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
export function toCreateTableSql(resolved: ResolvedAppSchema): string {
  const { table, id, fields } = resolved;
  const shape = expectedShape(resolved);

  const declaredForeignKeys = fields
    .map(({ name, def }) => foreignKeySql(table, name, def))
    .filter((line): line is string => line !== null);

  const lines = [
    `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
    '    `id` int(11) NOT NULL AUTO_INCREMENT,',
    ...shape.columns
      .filter((c) => !c.autoIncrement)
      .map(({ name, def }) => `${columnSql(name, def)},`),
    '    PRIMARY KEY (`id`),',
    ...shape.indexes.map(indexSql),
    ...declaredForeignKeys,
    `    CONSTRAINT \`fk_${id}_citizenid\` FOREIGN KEY (\`citizenid\`)`,
    '        REFERENCES `players` (`citizenid`) ON DELETE CASCADE',
    ') ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;'
  ];

  return lines.join('\n');
}

/**
 * A child table's `CREATE TABLE`. Nothing is implicit beyond an optional
 * auto-increment id — these tables disagree about whether they carry `status` or
 * timestamps, which is exactly why they cannot use the primary-table shape.
 */
export function toChildTableSql(child: ChildTableDefinition): string {
  const entries = Object.entries(child.columns).map(
    ([name, spec]) => [name, normalize(spec)] as const
  );

  const foreignKeys = entries
    .map(([name, def]) => foreignKeySql(child.name, name, def))
    .filter((line): line is string => line !== null);

  const body = [
    ...(child.autoIncrementId === false ? [] : ['    `id` int(11) NOT NULL AUTO_INCREMENT,']),
    ...entries.map(([name, def]) => `${columnSql(name, def)},`),
    ...(child.autoIncrementId === false ? [] : ['    PRIMARY KEY (`id`),']),
    ...(child.indexes ?? []).map((i) => indexSql(normalizeIndex(i))),
    ...foreignKeys
  ];

  // The last body line carries a trailing comma; strip it.
  const last = body.length - 1;
  body[last] = body[last].replace(/,$/, '');

  return [
    `CREATE TABLE IF NOT EXISTS \`${child.name}\` (`,
    ...body,
    ') ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;'
  ].join('\n');
}

/**
 * A generated file's contents: the primary table, then every child table in
 * declaration order so foreign keys resolve.
 */
export function toSqlFile(resolved: ResolvedAppSchema): string {
  const blocks = [
    toCreateTableSql(resolved),
    ...resolved.childTables.map((child) => toChildTableSql(child))
  ];

  return [
    `-- Generated from the '${resolved.id}' defineServerApp declaration.`,
    '-- Do not edit by hand; change the declaration and regenerate.',
    '',
    blocks.join('\n\n'),
    ''
  ].join('\n');
}
