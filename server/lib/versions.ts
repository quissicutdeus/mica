// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { Database } from './Database';
import { PlayerFacingError } from './errors';
import { statusWritesMayRun } from './statusWrites';
import {
  contentContext,
  contextColumns,
  encryptedColumn,
  isSealed,
  tryOpenContent,
  UNREADABLE_CONTENT
} from './contentCipher';

/**
 * The version ledger (MICA-430): what an edit replaced, kept for evidence. Owner rule:
 * everything is kept, including what an edit overwrites. Players keep seeing only the latest
 * version; staff can read every one (`reports:versions`).
 *
 * One table for every source, keyed by `source_table` and `source_id`, declared by the
 * `versions` service (`services/Versions.ts`) so it is an owned table with a status: every purge
 * erases a player's versions with the rest of their rows, kept and hidden (MICA-428).
 */
export const VERSIONS_TABLE = 'mica_versions';

/** Why a value was replaced. Frozen into the ledger's ENUM, so append only. */
export const VERSION_REASONS = ['edit', 'rename', 'revive', 'handover', 'rejoin'] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

/**
 * The longest snapshot the ledger's `mediumtext` holds, in bytes. A declaration whose versioned
 * columns could outgrow it is refused at resource start (`assertSnapshotFits`), so no edit can
 * reach the write with a snapshot that does not fit; if one ever did, strict mode refuses the
 * insert, the transaction rolls back, and the edit is refused with it — never written without
 * its version, and never truncated.
 */
export const SNAPSHOT_CAPACITY = 16_777_215;

/**
 * The worst case for one value inside the snapshot JSON: JSON escapes a control character as
 * six bytes (`\u0000`), so a value can grow six-fold. A sealed value is ASCII with nothing to
 * escape; the bound is for plaintext.
 */
const JSON_GROWTH = 6;

/** Per key in the snapshot: its quoted name, a colon, a comma, and the quotes round the value. */
const KEY_OVERHEAD = 8;

/**
 * Refuse a table whose versioned columns could make a snapshot the ledger cannot hold. `bytes`
 * is each snapshot column's capacity in bytes; null for one with no bound, which is refused.
 */
export const assertSnapshotFits = (
  table: string,
  bytes: Readonly<Record<string, number | null>>
): void => {
  let total = 64;
  for (const [column, size] of Object.entries(bytes)) {
    if (size === null) {
      throw new Error(
        `[versions] ${table}.${column} is versioned but has no bound, so its snapshot could ` +
          'outgrow the ledger.'
      );
    }
    total += column.length + KEY_OVERHEAD + size * JSON_GROWTH;
  }
  if (total > SNAPSHOT_CAPACITY) {
    throw new Error(
      `[versions] ${table}'s versioned columns could make a ${total}-byte snapshot; the ledger ` +
        `holds ${SNAPSHOT_CAPACITY}.`
    );
  }
};

/**
 * The columns a version of `values` keeps beside them: the owner, and every column an encrypted
 * one's authenticated data binds (MICA-431, MICA-432). A sealed value is copied verbatim, never
 * opened or re-sealed, and opens from the snapshot exactly as it did on the row — the AAD binds
 * the table, column, owner and scope, never the row id.
 */
export const versionContext = (
  table: string,
  values: readonly string[],
  hasOwner: boolean
): string[] => {
  const out = new Set<string>(hasOwner ? ['citizenid'] : []);
  for (const column of values) {
    const entry = encryptedColumn(table, column);
    if (entry) for (const name of contextColumns(entry)) out.add(name);
  }
  return [...out];
};

export interface VersionedWrite {
  /** The source table: a declared identifier, never a payload's. */
  table: string;
  /**
   * The alias `where` names the table by, when it has one (`c.\`id\` = ?`); every column the
   * lock and the snapshot read is qualified by it, or by the table's own name.
   */
  alias?: string;
  /** The columns whose replaced values are the version. */
  values: readonly string[];
  /** What else the snapshot keeps: `versionContext`. Never sent to a player. */
  context: readonly string[];
  /** Whether the source has `updated_at`: the snapshot keeps when the old value was written. */
  hasUpdatedAt: boolean;
  /**
   * The write's own `WHERE`, without the keyword. The read, the lock, the snapshot and the
   * write are all built on it. A `NOW()` in it is read once for the whole transaction
   * (`VERSION_NOW`), so an edit window cannot close between the snapshot and the write.
   */
  where: string;
  whereParams: readonly unknown[];
  /**
   * What the write puts in each versioned column, as plaintext. A row whose every versioned
   * column already holds it is written without a version (a save that changes nothing keeps
   * nothing). A column left out counts as changed: a reset to its `DEFAULT`, a value the
   * predicate itself says differs.
   */
  next: Readonly<Record<string, unknown>>;
  reason: VersionReason;
  /** The acting player, or null for the server or staff. */
  editedBy: string | null;
  /** The write's `SET`, without the keyword, and its parameters. */
  set: { sql: string; params: readonly unknown[] };
}

type ReadRows = (query: string, params: unknown[]) => Promise<unknown>;
const fromDatabase: ReadRows = (query, params) => Database.query(query, params);
let readRows: ReadRows = fromDatabase;

/**
 * Tests only: answer `writeVersioned`'s first read, so a suite's queued `query` answers stay
 * its own (`__tests__/versionedWrites.ts`). Null restores the database. `test:schema` and a live
 * server always read the table.
 */
export const __setVersionReadForTests = (read: ReadRows | null): void => {
  readRows = read ?? fromDatabase;
};

/** What a versioned write did. */
export interface VersionedResult {
  /** Rows whose versioned values changed: each has exactly one new version. */
  changed: number;
  /** Whether the write applied to any row: a save that changed nothing applied too. */
  applied: boolean;
}

/** The transaction's own clock, for a `where` with a time in it (an edit window). */
export const VERSION_NOW = '@mica_versions_now';

/**
 * Whether `next`, the value an edit would write, is what `table.column` already holds in `row`
 * — a sealed value compared as the plaintext it opens to, under the row's own context. A save
 * that changes nothing writes no version (MICA-430 review); one that cannot be opened to tell
 * counts as a change, so nothing is ever lost to a guess.
 */
export const unchanged = (
  table: string,
  row: Readonly<Record<string, unknown>>,
  column: string,
  next: unknown
): boolean => {
  const stored = row[column];
  if (stored === null || stored === undefined || next === null || next === undefined) {
    return (stored ?? null) === (next ?? null);
  }
  const entry = encryptedColumn(table, column);
  if (entry && isSealed(String(stored))) {
    let opened: string | null = null;
    try {
      opened = tryOpenContent(contentContext(entry, row), String(stored));
    } catch {
      opened = null;
    }
    return opened !== null && opened === String(next);
  }
  return String(stored) === String(next);
};

const q = (name: string): string => `\`${name}\``;

const jsonOf = (row: string, columns: readonly string[]): string =>
  columns.length === 0
    ? 'JSON_OBJECT()'
    : `JSON_OBJECT(${columns.map((column) => `'${column}', ${row}.${q(column)}`).join(', ')})`;

/**
 * Write `set` to the rows `where` names, keeping what it replaces in the version ledger
 * (MICA-430). A version exists exactly when its row's versioned values changed, and only then.
 *
 * 1. **Read** the rows, and open what is sealed: a row whose versioned columns already hold
 *    `next` changes nothing worth keeping.
 * 2. **The changed rows**, in one transaction: the clock fixed, the rows locked, the snapshot
 *    `INSERT … SELECT`, the write. Every statement names each row with the values step 1 read,
 *    byte for byte, so a row another write moved in between is neither versioned nor written,
 *    and the caller hears it as not applied. The count is read back by the transaction's own
 *    `op_key`; a failed transaction rolled back whole, and throws.
 * 3. **The unchanged rows**, one guarded write: overwriting a value with itself loses nothing,
 *    so it needs no version, and the same guard keeps a value that moved since from being
 *    lost without one.
 *
 * A guard that misses means another write landed in between: all three are run once more.
 */
export const writeVersioned = async (write: VersionedWrite): Promise<VersionedResult> => {
  /**
   * Never while the database is behind the code (`lib/statusWrites.ts`): before `micaschema
   * apply` the ledger may not exist, and an edit is never written without its version. Refused
   * whole, nothing written, and said to the player as what it is; the console says why, once.
   */
  if (!(await statusWritesMayRun('a versioned edit', { [VERSIONS_TABLE]: ['active'] }))) {
    throw new PlayerFacingError(
      'This cannot be saved until the server has finished updating. Try again later.',
      { key: 'server.versions.notReady' }
    );
  }
  // Qualified throughout, so a `where` that reaches into another table (an `EXISTS` over its
  // members) can never have one of these columns read off that table instead.
  const row = write.alias ?? q(write.table);
  const from = write.alias ? `${q(write.table)} ${write.alias}` : q(write.table);
  const read = [...new Set(['id', ...write.values, ...write.context])];
  /** One read and write; `missed` when a guard found a row another write moved since the read. */
  const attempt = async (): Promise<{ versioned: number; rewritten: boolean; missed: boolean }> => {
    const rows = await readRows(
      `SELECT ${read.map((column) => `${row}.${q(column)} AS ${q(column)}`).join(', ')} ` +
        `FROM ${from} WHERE ${write.where}`,
      [...write.whereParams]
    );
    const changed: Record<string, unknown>[] = [];
    const same: Record<string, unknown>[] = [];
    for (const found of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
      const moves = write.values.some(
        (column) =>
          !(column in write.next) || !unchanged(write.table, found, column, write.next[column])
      );
      (moves ? changed : same).push(found);
    }

    /** The rows as read: each by its id and every versioned value, compared as bytes. */
    const guard = (
      picked: readonly Record<string, unknown>[]
    ): { sql: string; params: unknown[] } => ({
      sql:
        ' AND (' +
        picked
          .map(
            () =>
              `(${row}.${q('id')} = ?` +
              write.values
                .map((column) => ` AND CAST(${row}.${q(column)} AS BINARY) <=> CAST(? AS BINARY)`)
                .join('') +
              ')'
          )
          .join(' OR ') +
        ')',
      params: picked.flatMap((found) => [
        found.id,
        ...write.values.map((column) => found[column] ?? null)
      ])
    });

    let versioned = 0;
    if (changed.length > 0) {
      const opKey = randomBytes(16).toString('hex');
      const named = guard(changed);
      // One clock for the whole transaction: the snapshot and the write judge an edit window
      // at the same instant, so neither can apply without the other (MICA-430 review).
      const where = `${write.where.replaceAll('NOW()', VERSION_NOW)}${named.sql}`;
      const whereParams = [...write.whereParams, ...named.params];
      const snapshot =
        `JSON_OBJECT('values', ${jsonOf(row, write.values)}, 'context', ${jsonOf(row, write.context)}, ` +
        `'written_at', ${write.hasUpdatedAt ? `UNIX_TIMESTAMP(${row}.${q('updated_at')})` : 'NULL'})`;
      const ok = await Database.transaction([
        { query: `SET ${VERSION_NOW} = NOW()`, params: [] },
        {
          query: `SELECT ${row}.${q('id')} FROM ${from} WHERE ${where} FOR UPDATE`,
          params: whereParams
        },
        {
          query:
            `INSERT INTO ${q(VERSIONS_TABLE)} (${q('citizenid')}, ${q('source_table')}, ` +
            `${q('source_id')}, ${q('edited_by')}, ${q('reason')}, ${q('snapshot')}, ${q('op_key')}) ` +
            `SELECT ${row}.${q('citizenid')}, ?, ${row}.${q('id')}, ?, ?, ${snapshot}, ? ` +
            `FROM ${from} WHERE ${where}`,
          params: [write.table, write.editedBy, write.reason, opKey, ...whereParams]
        },
        {
          query: `UPDATE ${from} SET ${write.set.sql} WHERE ${where}`,
          params: [...write.set.params, ...whereParams]
        }
      ]);
      if (!ok) {
        throw new Error(
          `[versions] a versioned write to ${write.table} failed and was rolled back whole.`
        );
      }
      const written = await Database.scalar<number | string | null>(
        `SELECT COUNT(*) FROM ${q(VERSIONS_TABLE)} WHERE ${q('source_table')} = ? AND ${q('op_key')} = ?`,
        [write.table, opKey]
      );
      versioned = Number(written) || 0;
    }
    let rewritten = false;
    if (same.length > 0) {
      const named = guard(same);
      rewritten = await Database.update(
        `UPDATE ${from} SET ${write.set.sql} WHERE ${write.where}${named.sql}`,
        [...write.set.params, ...write.whereParams, ...named.params]
      );
    }
    return {
      versioned,
      rewritten,
      missed: (changed.length > 0 && versioned < changed.length) || (same.length > 0 && !rewritten)
    };
  };

  /**
   * Two edits of one row at once (MICA-430 re-review): both read it, the first writes, and the
   * second's guard no longer matches. It reads again and writes over the first, so both land,
   * last writer winning, each with the version of what it replaced. Once only: a row that left
   * the predicate (taken down, deleted) is not there to read again, and answers not applied.
   */
  const first = await attempt();
  const second = first.missed ? await attempt() : null;
  const passes = second ? [first, second] : [first];
  return {
    changed: passes.reduce((sum, pass) => sum + pass.versioned, 0),
    applied: passes.some((pass) => pass.versioned > 0 || pass.rewritten)
  };
};

/** A ledger row as the staff read selects it. */
export interface VersionRow {
  id: number;
  citizenid: unknown;
  edited_by: unknown;
  reason: unknown;
  snapshot: unknown;
  created_at: unknown;
}

/** One version, opened for staff: the `reports:versions` reply's item. */
export interface ContentVersion {
  id: number;
  reason: VersionReason;
  replaced_at: string;
  written_at: string | null;
  by_owner: boolean | null;
  values: { column: string; value: string | null }[];
}

/** Columns a version never shows, whatever it kept: an owner, a phone (MICA-433). */
const NEVER_SHOWN: ReadonlySet<string> = new Set(['citizenid', 'device_id']);

/**
 * One instant as ISO 8601, whatever shape it arrived in (MICA-430 review): seconds since the
 * epoch (the snapshot's `written_at`, and the staff read's own `UNIX_TIMESTAMP`), milliseconds
 * (oxmysql's default for a timestamp), a `Date`, or MariaDB's `YYYY-MM-DD hh:mm:ss` text, read
 * as oxmysql itself would. Null for nothing to read.
 */
export const isoOf = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const n =
    typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  if (Number.isFinite(n)) return new Date(n < 1e11 ? n * 1000 : n).toISOString();
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Open each version of a row of `table` for staff (MICA-430). A sealed value opens under the
 * context the snapshot kept beside it, exactly as it did on the row; one no loaded key opens
 * reads as the padlock, and a snapshot that will not parse shows no values rather than failing
 * the read. The context itself, the owner and the editor never leave the server.
 */
export const readVersions = (table: string, rows: readonly VersionRow[]): ContentVersion[] =>
  rows.map((row) => {
    let snapshot: { values?: Record<string, unknown>; context?: Record<string, unknown> } = {};
    let writtenAt: string | null = null;
    try {
      const parsed = JSON.parse(String(row.snapshot)) as Record<string, unknown>;
      snapshot = parsed;
      writtenAt =
        parsed.written_at === null || parsed.written_at === undefined
          ? null
          : isoOf(parsed.written_at);
    } catch {
      snapshot = {};
    }
    const context = snapshot.context ?? {};
    const values = Object.entries(snapshot.values ?? {})
      .filter(([column]) => !NEVER_SHOWN.has(column))
      .map(([column, stored]) => {
        if (stored === null || stored === undefined) return { column, value: null };
        const text = String(stored);
        const entry = encryptedColumn(table, column);
        if (!entry || !isSealed(text)) return { column, value: text };
        let opened: string | null = null;
        try {
          opened = tryOpenContent(contentContext(entry, context), text);
        } catch {
          opened = null;
        }
        return { column, value: opened ?? UNREADABLE_CONTENT };
      });
    const editor =
      row.edited_by === null || row.edited_by === undefined ? null : String(row.edited_by);
    return {
      id: Number(row.id),
      reason: String(row.reason) as VersionReason,
      // Always set: the ledger's `created_at` is NOT NULL.
      replaced_at: isoOf(row.created_at) ?? '',
      written_at: writtenAt,
      by_owner: editor === null ? null : editor === String(row.citizenid),
      values
    };
  });
