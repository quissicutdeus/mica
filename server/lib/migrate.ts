import { normalizeIndex, type ChildTableDefinition, type ColumnDef } from './defineService';
import {
  columnDefinitionSql,
  expectedShape,
  indexDefinitionSql,
  type ExpectedShape
} from './schemaSql';
import type { ResolvedService } from './defineService';

/**
 * Bring a live table up to the shape its declaration describes.
 *
 * `generate:sql` only ever emitted `CREATE TABLE IF NOT EXISTS`, so a column added to
 * an existing app reached a fresh install and never reached an upgraded one. The
 * `IF NOT EXISTS` made that silent: re-running the file on a live database succeeds and
 * changes nothing. `archived_at` on the participants table shipped exactly that way.
 *
 * Deliberately **additive only**. Adding a column or an index cannot lose data; a drop,
 * a rename or a type change can, and none of the three is inferable from a diff — a
 * renamed column is indistinguishable from one dropped and another added. Those are
 * reported for a human to act on, never applied.
 */

export interface PlannedStatement {
  /** What this does, in one line, for the startup log. */
  description: string;
  sql: string;
}

export interface MigrationPlan {
  table: string;
  /** Statements safe to run unattended. */
  additive: PlannedStatement[];
  /**
   * Differences that need a person: a declared column whose live type disagrees, or a
   * live column nothing declares. Never actioned automatically.
   */
  drift: string[];
  /** True when the table does not exist yet and the CREATE should run instead. */
  missingTable: boolean;
}

/** One row of `information_schema.columns`, reduced to what the planner needs. */
export interface LiveColumn {
  name: string;
  /** `COLUMN_TYPE`, e.g. `varchar(50)`, `enum('active','deleted')`. */
  type: string;
  nullable: boolean;
}

export interface LiveTable {
  exists: boolean;
  columns: LiveColumn[];
  /** Index names only. Comparing constituent columns adds little and misreads often. */
  indexes: string[];
}

/** Integer types, whose parenthesised number is display width rather than size. */
const INTEGER_TYPE = /^(tinyint|smallint|mediumint|int|bigint)\b/;

/**
 * Compare a declared type to a live `COLUMN_TYPE`.
 *
 * The parenthesised number means two different things and must not be treated alike.
 * On `int(11)` it is display width — cosmetic, and MySQL stops reporting it from
 * 8.0.19, so insisting on it would print false drift on every start. On `varchar(64)`
 * it is the actual length, and ignoring it would let a column declared as 64 sit
 * silently as 16 and truncate.
 */
const typesAgree = (expected: string, live: string): boolean => {
  const clean = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/"/g, "'");
  const a = clean(expected);
  const b = clean(live);
  if (a === b) return true;

  if (INTEGER_TYPE.test(a) && INTEGER_TYPE.test(b)) {
    return a.replace(/\(\d+\)/, '') === b.replace(/\(\d+\)/, '');
  }
  return false;
};

/**
 * The declared type of a column as it would appear in `COLUMN_TYPE`.
 *
 * Derived from the same `columnDefinitionSql` the creator uses, so a new column type
 * cannot be understood by one and not the other.
 */
const declaredType = (name: string, def: ColumnDef): string => {
  const sql = columnDefinitionSql(name, def);
  // `` `name` type rest... `` — take everything between the backticked name and the
  // first modifier keyword.
  const afterName = sql.slice(sql.indexOf('`', 1) + 1).trim();
  return afterName.split(/\s+(?=NOT NULL|DEFAULT|ON UPDATE|AUTO_INCREMENT)/i)[0].trim();
};

const planFor = (
  table: string,
  columns: { name: string; def: ColumnDef; autoIncrement?: boolean }[],
  indexes: { name: string; columns: readonly string[]; unique: boolean }[],
  live: LiveTable
): MigrationPlan => {
  const plan: MigrationPlan = { table, additive: [], drift: [], missingTable: !live.exists };
  if (!live.exists) return plan;

  const liveByName = new Map(live.columns.map((c) => [c.name.toLowerCase(), c]));
  const liveIndexes = new Set(live.indexes.map((i) => i.toLowerCase()));

  for (const column of columns) {
    const existing = liveByName.get(column.name.toLowerCase());

    if (!existing) {
      // An auto-increment primary key is not something to bolt onto a live table
      // unattended, and its absence means something is very wrong anyway.
      if (column.autoIncrement) {
        plan.drift.push(`${table}.${column.name} is missing and cannot be added safely`);
        continue;
      }
      plan.additive.push({
        description: `add column ${table}.${column.name}`,
        sql: `ALTER TABLE \`${table}\` ADD COLUMN ${columnDefinitionSql(column.name, column.def)}`
      });
      continue;
    }

    const expectedType = declaredType(column.name, column.def);
    if (!typesAgree(expectedType, existing.type)) {
      plan.drift.push(
        `${table}.${column.name} is \`${existing.type}\` but declared \`${expectedType}\``
      );
    }
  }

  for (const index of indexes) {
    if (!liveIndexes.has(index.name.toLowerCase())) {
      plan.additive.push({
        description: `add index ${table}.${index.name}`,
        sql: `ALTER TABLE \`${table}\` ADD ${indexDefinitionSql(index)}`
      });
    }
  }

  const declared = new Set(columns.map((c) => c.name.toLowerCase()));
  for (const column of live.columns) {
    if (!declared.has(column.name.toLowerCase())) {
      // Informational. It may be someone else's addition, and dropping it is exactly
      // the kind of irreversible guess this planner refuses to make.
      plan.drift.push(`${table}.${column.name} exists but is not declared`);
    }
  }

  return plan;
};

export const planAppMigration = (resolved: ResolvedService, live: LiveTable): MigrationPlan => {
  const shape: ExpectedShape = expectedShape(resolved);
  return planFor(shape.table, shape.columns, [...shape.indexes], live);
};

export const planChildMigration = (child: ChildTableDefinition, live: LiveTable): MigrationPlan => {
  const columns = Object.entries(child.columns).map(([name, spec]) => ({
    name,
    def: typeof spec === 'string' ? ({ type: spec } as ColumnDef) : spec
  }));

  // Child tables declare everything except the optional id, matching `toChildTableSql`.
  const all =
    child.autoIncrementId === false
      ? columns
      : [
          { name: 'id', def: { type: 'int', notNull: true } as ColumnDef, autoIncrement: true },
          ...columns
        ];

  return planFor(child.name, all, (child.indexes ?? []).map(normalizeIndex), live);
};

/** Nothing to do — used to keep the startup log quiet when a schema is already current. */
export const isNoop = (plan: MigrationPlan): boolean =>
  !plan.missingTable && plan.additive.length === 0 && plan.drift.length === 0;
