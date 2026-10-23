// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { formatBytes } from './media/stats';
import { reasonOf } from './sqlErrors';

/**
 * `micastorage`: where a server's micaOS storage goes, table by table.
 *
 * Since MICA-428 and MICA-429 nothing in micaOS deletes a row. Retention, erasure and a
 * player's own delete each move a status, so the database only grows, and an owner needs to
 * see which tables hold it and how much of each is still live. For every `mica_` table this
 * reads its data and index bytes and counts its rows by status, `active` apart from every
 * other status; a table with no status column (the audit log, the migrations ledger) gets a
 * plain row count.
 *
 * **Two round trips, whatever the table count.** In game every statement waits for a server
 * tick, so this reads `information_schema` once (sizes and each table's status column, in one
 * statement) and counts every table in one `UNION ALL`, which is also one consistent snapshot.
 *
 * **The status values come from the database, never from a list here.** Which tables have a
 * status, and the order its values print in, is the column's own `ENUM` as `information_schema`
 * spells it; the counts are `GROUP BY status`, so a value outside that list (an `ENUM`'s `''`,
 * written under a non-strict `sql_mode`) is still counted and printed rather than lost.
 *
 * **It prints schema, never rows**: table names, status names, counts and sizes. No citizenid
 * and no row content is selected, so none can be printed.
 *
 * The sizes are InnoDB's statistics, refreshed when about a tenth of a table changes or by
 * `ANALYZE TABLE`, so they lag a table that just grew. The row counts are exact.
 */

export const STORAGE_TAG = '[micastorage]';

/** The one status that means live. Every other value is a row kept but not active. */
const ACTIVE = 'active';

/** One `mica_` table as `information_schema` describes it. */
export interface TableSize {
  name: string;
  dataBytes: number;
  indexBytes: number;
  /**
   * The `status` column's declared values, in declared order. `null` when the table has no
   * status column; empty when it has one whose type declares no values (a `varchar`).
   */
  statuses: string[] | null;
}

/** A table's rows: the total, and per status value as counted. */
export interface TableRows {
  total: number;
  /** Status value → rows, for a table with a status column; empty for one without. */
  byStatus: Map<string | null, number>;
}

export interface TableStorage extends TableSize {
  /** `null` when the count could not be read; the sizes still print. */
  rows: TableRows | null;
}

export interface StorageReport {
  /** Largest first. */
  tables: TableStorage[];
  /** Why the rows were not counted, or `null` when they were. */
  countFailure: string | null;
}

/**
 * Every `mica_` base table in the connected schema with its sizes (`k` 0), and every `mica_`
 * table's `status` column type (`k` 1), in one statement.
 *
 * A `UNION ALL` of two single-table reads rather than a join, because MariaDB narrows an
 * `information_schema` read by its own `WHERE` only: measured on 12.3 beside 400 tables that
 * were not micaOS's, a `LEFT JOIN ... COLUMNS` read every table definition on the server
 * ("Scanned all databases", 563 opened, about 30 ms), where each branch here opens the 50
 * `mica_` tables and nothing else (under 5 ms). A view's columns can reach the second branch;
 * only a name the first branch answered becomes a table, so one never does.
 */
export const TABLE_SIZES_SQL =
  'SELECT 0 AS `k`, TABLE_NAME AS `name`, DATA_LENGTH AS `dataBytes`, ' +
  'INDEX_LENGTH AS `indexBytes`, NULL AS `statusType` ' +
  'FROM information_schema.TABLES ' +
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
  "AND TABLE_NAME LIKE 'mica|_%' ESCAPE '|' " +
  'UNION ALL ' +
  'SELECT 1, TABLE_NAME, NULL, NULL, COLUMN_TYPE ' +
  'FROM information_schema.COLUMNS ' +
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'mica|_%' ESCAPE '|' " +
  "AND COLUMN_NAME = 'status'";

/** The values of an `enum('a','b')` column type, as `information_schema` spells it. */
export const enumValues = (type: string): string[] | null => {
  const match = /^enum\((.*)\)$/i.exec(type.trim());
  if (!match) return null;
  return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

const bytesOf = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Read every `mica_` table's sizes and status column. Throws when it cannot be read. */
export const readTableSizes = async (): Promise<TableSize[]> => {
  const rows = await Database.query<Record<string, unknown>[]>(TABLE_SIZES_SQL, []);
  if (!Array.isArray(rows)) throw new Error('information_schema.TABLES answered no rows');
  // A row from oxmysql is another realm's object: read it by shape, never by prototype.
  const statusTypes = new Map<string, string>();
  for (const row of rows) {
    if (Number(row?.k) === 1) statusTypes.set(String(row?.name), String(row?.statusType ?? ''));
  }
  return rows
    .filter((row) => Number(row?.k) === 0)
    .map((row) => {
      const name = String(row?.name);
      const type = statusTypes.get(name);
      return {
        name,
        dataBytes: bytesOf(row?.dataBytes),
        indexBytes: bytesOf(row?.indexBytes),
        statuses: type === undefined ? null : (enumValues(type) ?? [])
      };
    });
};

/** A name as a quoted identifier. A backtick inside one is doubled, which is all it needs. */
const quoted = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/**
 * One statement counting every table: a `GROUP BY status` per table that has the column, a plain
 * `COUNT(*)` per table that does not, each tagged with the table's position in `tables`.
 * `CONVERT(... USING utf8mb4)` puts every branch's status in one character set, so what the
 * column holds never depends on which tables the union happens to combine. (MariaDB 11 and 12
 * accept the union without it, `latin1` beside `utf8mb4` included, by dropping the collation.)
 */
export const countRowsSql = (tables: readonly TableSize[]): string =>
  tables
    .map((table, i) =>
      table.statuses === null
        ? `SELECT ${i} AS \`t\`, NULL AS \`s\`, COUNT(*) AS \`n\` FROM ${quoted(table.name)}`
        : `SELECT ${i} AS \`t\`, CONVERT(\`status\` USING utf8mb4) AS \`s\`, COUNT(*) AS \`n\` ` +
          `FROM ${quoted(table.name)} GROUP BY \`status\``
    )
    .join(' UNION ALL ');

/** Count every table's rows in one round trip. Throws when the statement fails. */
export const countRows = async (tables: readonly TableSize[]): Promise<TableRows[]> => {
  const tallies: TableRows[] = tables.map(() => ({ total: 0, byStatus: new Map() }));
  if (tables.length === 0) return tallies;
  const rows = await Database.query<Record<string, unknown>[]>(countRowsSql(tables), []);
  if (!Array.isArray(rows)) throw new Error('the row count answered no rows');
  for (const row of rows) {
    const tally = tallies[Number(row?.t)];
    if (!tally) continue;
    const n = Number(row?.n ?? 0);
    if (!Number.isFinite(n)) continue;
    tally.total += n;
    if (tables[Number(row?.t)].statuses !== null) {
      const status = row?.s === null || row?.s === undefined ? null : String(row.s);
      tally.byStatus.set(status, (tally.byStatus.get(status) ?? 0) + n);
    }
  }
  return tallies;
};

const sizeOf = (table: TableSize): number => table.dataBytes + table.indexBytes;

/** Code-unit order: the same on every server, whatever ICU its runtime was built with. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The whole report: sizes, then counts. A failed count still answers the sizes, with the
 * reason, since sizes are most of what an owner came for; a failed size read throws.
 */
export const readStorageReport = async (): Promise<StorageReport> => {
  const sizes = await readTableSizes();
  let counted: TableRows[] | null = null;
  let countFailure: string | null = null;
  try {
    counted = await countRows(sizes);
  } catch (error) {
    countFailure = reasonOf(error, 'the count failed');
  }
  const tables = sizes.map((size, i) => ({ ...size, rows: counted ? counted[i] : null }));
  tables.sort(
    (a, b) =>
      sizeOf(b) - sizeOf(a) || (b.rows?.total ?? 0) - (a.rows?.total ?? 0) || byText(a.name, b.name)
  );
  return { tables, countFailure };
};

/** How a status value prints: `''` and `NULL` would otherwise print as nothing at all. */
const statusLabel = (status: string | null): string =>
  status === null ? '(null)' : status === '' ? '(empty)' : status;

/**
 * A table's non-active statuses with rows, in the column's declared order, then any value the
 * declaration does not list, alphabetically.
 */
const inactiveOf = (table: TableStorage): [string, number][] => {
  const byStatus = table.rows?.byStatus ?? new Map<string | null, number>();
  const declared = table.statuses ?? [];
  const keys = [...byStatus.keys()].filter((status) => status !== ACTIVE);
  const rank = (status: string | null): number => {
    const at = status === null ? -1 : declared.indexOf(status);
    return at === -1 ? declared.length : at;
  };
  keys.sort((a, b) => rank(a) - rank(b) || byText(statusLabel(a), statusLabel(b)));
  return keys
    .map((status): [string, number] => [statusLabel(status), byStatus.get(status) ?? 0])
    .filter(([, n]) => n > 0);
};

const splitLine = (active: number, inactive: [string, number][]): string => {
  const others = inactive.reduce((sum, [, n]) => sum + n, 0);
  const detail = inactive.map(([status, n]) => `${status} ${n}`).join(', ');
  return `${active} active, ${others} inactive${detail ? ` (${detail})` : ''}`;
};

const sizeLine = (bytes: number, dataBytes: number, indexBytes: number): string =>
  `${formatBytes(bytes)} (${formatBytes(dataBytes)} data, ${formatBytes(indexBytes)} index)`;

const tableLine = (table: TableStorage): string => {
  const size = sizeLine(sizeOf(table), table.dataBytes, table.indexBytes);
  const prefix = `${STORAGE_TAG}   ${table.name}: ${size}; `;
  if (!table.rows) return `${prefix}rows not counted`;
  if (table.statuses === null) return `${prefix}${table.rows.total} row(s), no status column`;
  const active = table.rows.byStatus.get(ACTIVE) ?? 0;
  return `${prefix}${table.rows.total} row(s): ${splitLine(active, inactiveOf(table))}`;
};

/** The first line, which a reader (and the in-server scenario) finds the report by. */
export const STORAGE_HEADER =
  `${STORAGE_TAG} mica_ tables, largest first. ` +
  "Sizes are InnoDB's estimates; row counts are exact.";

const totalLine = (report: StorageReport): string => {
  const { tables } = report;
  const data = tables.reduce((sum, t) => sum + t.dataBytes, 0);
  const index = tables.reduce((sum, t) => sum + t.indexBytes, 0);
  const head =
    `${STORAGE_TAG} total: ${tables.length} table(s), ${sizeLine(data + index, data, index)}, ` +
    `${data + index} bytes; `;
  if (report.countFailure !== null) return `${head}rows not counted.`;

  let rows = 0;
  let active = 0;
  let plain = 0;
  const inactive = new Map<string, number>();
  for (const table of tables) {
    rows += table.rows?.total ?? 0;
    if (table.statuses === null) {
      plain += table.rows?.total ?? 0;
      continue;
    }
    active += table.rows?.byStatus.get(ACTIVE) ?? 0;
    for (const [status, n] of inactiveOf(table))
      inactive.set(status, (inactive.get(status) ?? 0) + n);
  }
  const byCount = [...inactive].sort(([a, x], [b, y]) => y - x || byText(a, b));
  return `${head}${rows} row(s): ${splitLine(active, byCount)}, ${plain} in tables with no status.`;
};

/** The report as console lines: the header, a line per table largest first, the total. */
export const formatStorageReport = (report: StorageReport): string[] => {
  if (report.tables.length === 0) return [`${STORAGE_TAG} no mica_ tables in this database.`];
  const lines = [STORAGE_HEADER];
  if (report.countFailure !== null) {
    lines.push(`${STORAGE_TAG} could not count rows (${report.countFailure}); sizes only.`);
  }
  for (const table of report.tables) lines.push(tableLine(table));
  lines.push(totalLine(report));
  return lines;
};

/** The size the toast names: every table's data and index together. */
export const totalBytes = (report: StorageReport): number =>
  report.tables.reduce((sum, table) => sum + sizeOf(table), 0);
