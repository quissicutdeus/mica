import type { ColumnDef, ColumnType, ResolvedAppSchema } from './defineServerApp';

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
  blob: () => 'mediumblob'
};

const sqlLiteral = (value: string | number | boolean | null): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
};

const columnSql = (name: string, def: ColumnDef): string => {
  const type = SQL_TYPES[def.type];
  if (!type) {
    throw new Error(`schemaSql: unknown column type '${def.type}' on '${name}'.`);
  }

  const parts = [`\`${name}\``, type(def)];
  if (def.notNull) parts.push('NOT NULL');
  if (def.default !== undefined) {
    parts.push(`DEFAULT ${sqlLiteral(def.default)}`);
  } else if (!def.notNull) {
    parts.push('DEFAULT NULL');
  }

  return `    ${parts.join(' ')}`;
};

/**
 * The full `CREATE TABLE` for an app, matching the conventions already in
 * gphone.sql: soft-delete `status` enum, citizenid FK onto `players` with cascade,
 * and a `(citizenid, status)` index because every generic read filters on both.
 */
export function toCreateTableSql(resolved: ResolvedAppSchema): string {
  const { table, id, statuses, fields, indexes } = resolved;

  const declared = fields.map(({ name, def }) => columnSql(name, def));
  const statusEnum = statuses.map((s) => `'${s}'`).join(', ');
  const indexed = fields.filter(({ def }) => def.index).map(({ name }) => name);
  const composite = indexes.map((cols) => {
    const name = cols.join('_');
    const list = cols.map((c) => `\`${c}\``).join(', ');
    return `    KEY \`${name}\` (${list}),`;
  });

  const lines = [
    `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
    '    `id` int(11) NOT NULL AUTO_INCREMENT,',
    '    `citizenid` varchar(50) NOT NULL,',
    ...declared.map((line) => `${line},`),
    `    \`status\` ENUM(${statusEnum}) NOT NULL DEFAULT 'active',`,
    '    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,',
    '    PRIMARY KEY (`id`),',
    '    KEY `status` (`status`),',
    '    KEY `citizenid_status` (`citizenid`, `status`),',
    ...indexed.map((name) => `    KEY \`citizenid_${name}\` (\`citizenid\`, \`${name}\`),`),
    ...composite,
    `    CONSTRAINT \`fk_${id}_citizenid\` FOREIGN KEY (\`citizenid\`)`,
    '        REFERENCES `players` (`citizenid`) ON DELETE CASCADE',
    ') ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;'
  ];

  return lines.join('\n');
}

/** A generated file's contents, header included so nobody hand-edits it. */
export function toSqlFile(resolved: ResolvedAppSchema): string {
  return [
    `-- Generated from the '${resolved.id}' defineServerApp declaration.`,
    '-- Do not edit by hand; change the declaration and regenerate.',
    '',
    toCreateTableSql(resolved),
    ''
  ].join('\n');
}
