// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { tablePresent } from './context';
import { Tally } from './report';

/**
 * Reading a source table a page at a time (MICA-233).
 *
 * A whole-table `SELECT` holds a big install's entire history in the server's memory at once
 * and can outrun `Database`'s 60-second timeout on one statement. So every table is read in
 * pages of `PAGE_SIZE`, by keyset on the columns the caller names: `WHERE (k1, k2) > (?, ?)
 * ORDER BY k1, k2 LIMIT n`, which costs the same for the last page as the first when the key is
 * indexed (a primary key always is).
 *
 * Message and post tables must be written oldest first — micaOS orders a thread (and the feed)
 * by row id — and where the primary key is not in time order (lb-phone's are strings) they go
 * through `chronological` below instead.
 *
 * `key: null` is for a table with no primary key at all (qb-phone's `phone_gallery`), paged by
 * offset. That is only stable while nothing writes to the table, which holds for an import
 * run from the console with the old phone stopped.
 *
 * Every identifier here — table, columns, key — comes from a literal in an importer. Only the
 * cursor values are bound. A read that fails is reported under its table and ends that table;
 * the rest of the import carries on.
 */
export const PAGE_SIZE = 1000;

export interface SourceSpec {
  table: string;
  columns: readonly string[];
  key: readonly string[] | null;
}

const ident = (name: string): string => `\`${name}\``;

/** A tally for the table, `present: false` when it does not exist. */
export const openSource = async (table: string): Promise<Tally> =>
  new Tally(table, await tablePresent(table));

/** The table's rows, a page at a time, in key order. Yields nothing for an absent table. */
export async function* pages<Row extends object>(
  tally: Tally,
  spec: SourceSpec
): AsyncGenerator<Row[]> {
  if (!tally.present) return;
  const select = `SELECT ${spec.columns.map(ident).join(', ')} FROM ${ident(spec.table)}`;
  let cursor: unknown[] | null = null;
  let offset = 0;
  let seen = 0;

  for (;;) {
    let sql: string;
    let params: unknown[] = [];
    if (spec.key === null) {
      sql = `${select} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    } else {
      const keys = spec.key.map(ident);
      const tuple = keys.length === 1 ? keys[0] : `(${keys.join(', ')})`;
      const marks = keys.length === 1 ? '?' : `(${keys.map(() => '?').join(', ')})`;
      sql =
        `${select}${cursor ? ` WHERE ${tuple} > ${marks}` : ''} ` +
        `ORDER BY ${keys.join(', ')} LIMIT ${PAGE_SIZE}`;
      params = cursor ?? [];
    }

    let rows: Row[];
    try {
      rows = (await Database.query<Row[]>(sql, params)) ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tally.unreadable = true;
      tally.skip(`could not read${seen ? ` past row ${seen}` : ''}: ${message}`, 0);
      return;
    }
    if (rows.length === 0) return;
    seen += rows.length;
    yield rows;
    if (rows.length < PAGE_SIZE) return;
    offset += rows.length;
    const last = rows[rows.length - 1] as Record<string, unknown>;
    cursor = spec.key ? spec.key.map((k) => last[k]) : null;
  }
}

/** How many rows a table holds, for a table whose rows cannot be used but must be counted. */
export const countRows = async (table: string): Promise<number> => {
  try {
    return Number(
      (await Database.scalar<number | null>(`SELECT COUNT(*) FROM ${ident(table)}`, [])) ?? 0
    );
  } catch {
    return 0;
  }
};

export interface ChronologicalSpec {
  table: string;
  /** Every column the writer needs; must include `id` and `time`. */
  columns: readonly string[];
  /** The primary key: a single column. */
  id: string;
  /** The column that orders rows in time. */
  time: string;
}

const timeOf = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/**
 * A table's rows oldest first, for a table whose primary key is not in time order and whose
 * time column has no index (lb-phone's messages and tweets: string ids, and no key on
 * `timestamp` or `channel_id` in the schema lb-phone ships).
 *
 * Paging on `(timestamp, id)` would re-sort the rest of the table for every page — five hundred
 * full sorts for half a million rows — and paging per thread on `channel_id` would scan the
 * whole table once per thread, since that column is not indexed either. So this reads the table
 * **once**, in primary-key pages, keeping only each row's id and time; sorts those in memory;
 * then fetches the full rows in that order by primary key, a page of ids at a time
 * (`WHERE id IN (…)`, point lookups on the key). One sequential scan plus key lookups, at the
 * cost of holding one id and one number per row — tens of megabytes for half a million.
 *
 * Global time order also puts every thread's messages in order, since each thread's are a
 * subsequence of it, and every reply after its parent.
 */
export async function* chronological<Row extends object>(
  tally: Tally,
  spec: ChronologicalSpec
): AsyncGenerator<Row[]> {
  const order: { id: unknown; at: number }[] = [];
  for await (const rows of pages<Record<string, unknown>>(tally, {
    table: spec.table,
    columns: [spec.id, spec.time],
    key: [spec.id]
  })) {
    for (const row of rows) order.push({ id: row[spec.id], at: timeOf(row[spec.time]) });
  }
  order.sort((a, b) => a.at - b.at || (String(a.id) < String(b.id) ? -1 : 1));

  const select = `SELECT ${spec.columns.map(ident).join(', ')} FROM ${ident(spec.table)}`;
  for (let i = 0; i < order.length; i += PAGE_SIZE) {
    const ids = order.slice(i, i + PAGE_SIZE).map((o) => o.id);
    let rows: Row[];
    try {
      rows =
        (await Database.query<Row[]>(
          `${select} WHERE ${ident(spec.id)} IN (${ids.map(() => '?').join(', ')})`,
          ids
        )) ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tally.unreadable = true;
      tally.skip(`could not read past row ${i}: ${message}`, 0);
      return;
    }
    // `IN` answers in any order; put the page back in time order.
    const byId = new Map(rows.map((r) => [String((r as Record<string, unknown>)[spec.id]), r]));
    yield ids.flatMap((id) => {
      const row = byId.get(String(id));
      return row ? [row] : [];
    });
  }
}
