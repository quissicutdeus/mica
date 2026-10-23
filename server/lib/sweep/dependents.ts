// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { ERASED } from '../statuses';
import { traceOf } from '../sqlErrors';
import { identifier } from './sql';

/**
 * Rows that hang off another micaOS table by its id rather than off an owner (MICA-429): a
 * follow, a block, a reaction or an ear off `mica_accounts`, a swipe or a match off `mica_spark`.
 * `columns` are its columns holding a parent row's id; a row is the parent's when any one does.
 *
 * Its own module, not the purge's: a reopen that puts a parent back to `erased` reaches this from
 * `moderation.ts`, which the purge itself imports.
 */
export interface DependentRows {
  table: string;
  columns: readonly string[];
}

const dependents = new Map<string, DependentRows[]>();

/**
 * Erase `rows.table`'s rows with their parent (MICA-429). They carry no citizenid, so no scope
 * reaches them; before MICA-428 the parent's delete cascaded onto them, and since then an erased
 * account's follows still counted on the profiles it followed. Now every row naming an erased
 * parent in any of `rows.columns` is erased too — one of the other player's own included, as the
 * cascade took it: a follow of an erased account, a block held against it. Nothing on the erased
 * side can act again, and the row is kept, for staff.
 *
 * Three ways in, so a parent erased by any road takes its rows with it: the purge that erased it
 * (`purgePlanned`), a reopen that puts a takedown back to `erased` (`restoreTarget`), and the
 * orphan sweep's catch-all (`eraseStrandedDependents`) for whatever either left.
 *
 * Registered by the owning service, once per table — `server/lib` names no service's table.
 */
export const registerDependentRows = (parent: string, rows: DependentRows): void => {
  identifier(parent, 'a parent table');
  identifier(rows.table, 'a dependent table');
  if (rows.columns.length === 0) {
    throw new Error(`registerDependentRows: '${rows.table}' names no column.`);
  }
  for (const column of rows.columns) identifier(column, 'a dependent column');
  const list = dependents.get(parent) ?? [];
  if (list.some((entry) => entry.table === rows.table)) {
    throw new Error(`registerDependentRows: '${rows.table}' is already registered.`);
  }
  dependents.set(parent, [...list, rows]);
};

/** The tables registered as hanging off `parent`. */
export const dependentsOf = (parent: string): readonly DependentRows[] =>
  dependents.get(parent) ?? [];

/** Every parent with dependents registered. */
const parents = (): string[] => [...dependents.keys()];

/**
 * How many parent ids one statement names, and how many rows it may move. Bounded both ways, so
 * one statement's lock footprint is bounded as the purge's are.
 */
export const DEPENDENT_CHUNK = 500;

/** A stop, not a target, per table and batch of parents: 100,000 rows. */
const MAX_ROUNDS = 200;

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown })?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

const yieldToServer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const positiveIds = (ids: readonly unknown[]): number[] =>
  [...new Set(ids.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);

/**
 * Every row of `rows.table` naming one of `ids` in `column`, moved to `erased`. One statement per
 * column and per batch of ids, `col IN (?, …)` against literal ids, so each uses that column's
 * own index. A subquery in its place could not, on MariaDB before 11.1, and under REPEATABLE READ
 * scanned and locked the whole table on every sweep (MICA-429 review).
 */
const eraseOneColumn = async (table: string, column: string, ids: number[]): Promise<number> => {
  const name = `\`${table}\``;
  let moved = 0;
  for (let at = 0; at < ids.length; at += DEPENDENT_CHUNK) {
    const batch = ids.slice(at, at + DEPENDENT_CHUNK);
    const marks = batch.map(() => '?').join(', ');
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) {
        throw new Error(
          `stopped after ${MAX_ROUNDS * DEPENDENT_CHUNK} rows; the rest are left for the next run.`
        );
      }
      const n = affectedRows(
        await Database.query(
          `UPDATE ${name} SET \`status\` = ? WHERE \`${column}\` IN (${marks}) ` +
            `AND \`status\` <> ? LIMIT ${DEPENDENT_CHUNK}`,
          [ERASED, ...batch, ERASED]
        )
      );
      moved += n;
      if (n < DEPENDENT_CHUNK) break;
      await yieldToServer();
    }
  }
  return moved;
};

export interface DependentResult {
  /** Rows moved to `erased`, by table. */
  byTable: Record<string, number>;
  failures: { table: string; error: unknown }[];
}

/**
 * Erase everything hanging off `ids`, rows of `parent` that are erased. Each dependent table is
 * its own failure, so one that fails does not keep the rest. The caller says the ids are erased;
 * a reopen and the purge both know, and the catch-all read them as such.
 */
export const eraseDependentsOf = async (
  parent: string,
  ids: readonly unknown[]
): Promise<DependentResult> => {
  const result: DependentResult = { byTable: {}, failures: [] };
  const live = positiveIds(ids);
  if (live.length === 0) return result;
  for (const rows of dependentsOf(parent)) {
    try {
      let moved = 0;
      for (const column of rows.columns) moved += await eraseOneColumn(rows.table, column, live);
      if (moved > 0) result.byTable[rows.table] = moved;
    } catch (error) {
      result.failures.push({ table: rows.table, error });
    }
  }
  return result;
};

/**
 * The catch-all (MICA-429 review): every erased parent that still has a row hanging off it not
 * yet erased, however it came to be erased — a purge that stopped part-way, a reopen whose own
 * erase failed, a parent erased before this existed. Walks the erased parents in id order a
 * bounded page at a time, on the parent's `status` index, asking each dependent column's own
 * index whether anything is left; then erases as above. Never driven from the dependent side,
 * which would read every live follow there is. Run by the orphan sweep. Never throws: a failure
 * is logged and returned, and the next run finishes it.
 */
export const eraseStrandedDependents = async (label = 'micaOS'): Promise<DependentResult> => {
  const total: DependentResult = { byTable: {}, failures: [] };
  for (const parent of parents()) {
    for (const rows of dependentsOf(parent)) {
      try {
        const left = rows.columns
          .map(
            (column) =>
              `EXISTS (SELECT 1 FROM \`${rows.table}\` d WHERE d.\`${column}\` = p.\`id\` ` +
              'AND d.`status` <> ?)'
          )
          .join(' OR ');
        let after = 0;
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const found = await Database.query<{ id: unknown }[]>(
            `SELECT p.\`id\` AS \`id\` FROM \`${parent}\` p WHERE p.\`status\` = ? ` +
              `AND p.\`id\` > ? AND (${left}) ORDER BY p.\`id\` LIMIT ${DEPENDENT_CHUNK}`,
            [ERASED, after, ...rows.columns.map(() => ERASED)]
          );
          const ids = positiveIds((found ?? []).map((row) => row.id));
          if (ids.length === 0) break;
          let moved = 0;
          for (const column of rows.columns) moved += await eraseOneColumn(rows.table, column, ids);
          if (moved > 0) total.byTable[rows.table] = (total.byTable[rows.table] ?? 0) + moved;
          after = Math.max(...ids);
          if (ids.length < DEPENDENT_CHUNK) break;
          await yieldToServer();
        }
      } catch (error) {
        console.error(
          `[${label}] erasing what still hangs off erased ${parent} rows in ${rows.table} failed:`,
          traceOf(error)
        );
        total.failures.push({ table: rows.table, error });
      }
    }
  }
  return total;
};
