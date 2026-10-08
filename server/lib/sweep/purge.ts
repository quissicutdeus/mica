// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { openReportHold } from '../contentRetention';
import { isReportableTable } from '../moderation';
import { identifier, type Clause } from './sql';
import {
  cascadeEdges,
  externals,
  type CascadeEdge,
  type OwnedExternal,
  type OwnedTable
} from './tables';
import type { OwnerScope } from './scope';

/**
 * How many rows one statement may name.
 *
 * An unbounded `DELETE` across 22 tables at boot holds row locks over the whole schema, and
 * every phone write on a busy server queues behind it. Deleting planned ids a chunk at a time
 * bounds one statement's lock footprint and lets the loop yield between batches.
 */
const DELETE_CHUNK = 500;

/**
 * How many passes a table that references itself gets — a stop, not a target.
 *
 * Such a table (a reply under a post) goes leaves first, one level per pass. A loop whose exit
 * condition is "the database stopped giving me rows" has no exit condition if the database
 * keeps giving them, and a boot-time task that never finishes is its own outage. Hitting this
 * is a failure for that table, said as one, never a silent keep.
 */
const MAX_CHUNKS = 200;

/**
 * Retention's open-report hold (`openReportHold`, MICA-167) for a table a player can report,
 * or `null` for one they cannot. MICA-292.
 *
 * The purge and the sweep used to take every row a character owned, reported or not, and
 * once they also delete the hosted file a player under an open report could delete their
 * character and destroy the photo that was reported. Retention never could, so neither can
 * these: a reported row, what hangs off it, and whatever those name, stay until the report
 * resolves, and the next sweep takes them then. The predicate is retention's own, not a copy.
 *
 * Only reportable tables, because only those have rows a report can name — and the hold
 * reads the row's `id`, which not every owned table has.
 */
const evidenceHold = (table: string, row: string): { sql: string; params: unknown[] } | null =>
  isReportableTable(table) ? openReportHold(table, row) : null;

/**
 * The most references collected per chunk: far more than one chunk's rows can name, so a
 * collect that fills it is worth a warning rather than routine.
 */
const COLLECT_LIMIT = MAX_CHUNKS * DELETE_CHUNK;

const releaseCollected = async (
  label: string,
  table: string,
  external: OwnedExternal,
  refs: readonly string[]
): Promise<void> => {
  if (refs.length === 0) return;
  if (refs.length >= COLLECT_LIMIT) {
    console.warn(
      `[${label}] ${table}: ${COLLECT_LIMIT} or more references were collected in one pass; ` +
        'some of what the deleted rows named may not have been released.'
    );
  }
  try {
    await external.release(refs);
  } catch (error) {
    console.error(`[${label}] releasing what the deleted ${table} rows named failed:`, error);
  }
};

export interface SweepFailure {
  table: string;
  error: unknown;
}

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown })?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

/** Let the server breathe between batches. Nothing is waiting on this. */
const yieldToServer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface PurgeException {
  table: string;
  /**
   * The rows to keep, as SQL over the row qualifier `row`. Absent keeps the whole table.
   * Built by the caller from declared identifiers only; it is interpolated.
   */
  keep?: (row: string) => { sql: string; params: unknown[] };
}

/**
 * What a purge keeps beyond the report hold, and which child tables go with their parent.
 * The character-deleted purge passes no `except`; a player's own delete does (MICA-168).
 */
export interface PurgeOptions {
  except?: readonly PurgeException[];
  /** Never let a `DELETE` cascade into a row this purge would not delete itself. */
  cascade?: CascadeOptions;
  /**
   * Purge only these. Defaults to every owned table. A table left out is never deleted from,
   * so a row in it that references a purged table keeps what it references.
   */
  only?: readonly OwnedTable[];
  /** What a failure is logged as being for. Defaults to a player's own delete. */
  purpose?: string;
}

export interface CascadeOptions {
  /**
   * Tables with no owner column whose rows belong to their parent row and go with it — a tag
   * on a post, a like of it, a follow of an account. Named by the caller, since which tables
   * those are is a per-app fact. A child table that is neither owned nor named here keeps its
   * parent whenever it has a row, which is the safe answer and the reason a new one is a
   * decision (`privacy.test.ts`).
   */
  dependents: readonly string[];
}

const withKept = (
  hold: Clause | null,
  exception: PurgeException | undefined,
  row: string
): Clause | null => {
  const keep = exception?.keep?.(row);
  if (!keep) return hold;
  const sql = `NOT (${keep.sql})`;
  return hold
    ? { sql: `${hold.sql} AND ${sql}`, params: [...hold.params, ...keep.params] }
    : { sql, params: keep.params };
};

export interface PurgeResult {
  removed: number;
  /**
   * The rows this purge left behind on purpose: what the report hold keeps, what hangs off a
   * held row, and what a cascade from it would have reached. Excepted rows are not counted,
   * nor is a table that failed.
   */
  kept: number;
  failures: SweepFailure[];
}

interface PlannedResult extends PurgeResult {
  byTable: Record<string, number>;
}

/**
 * Children before parents, among the owned tables: a table goes only once every owned table
 * that references it has gone. A cycle other than a table referencing itself cannot be
 * ordered, and is refused rather than guessed at.
 */
const childrenFirst = (
  tables: readonly OwnedTable[],
  edges: readonly CascadeEdge[]
): OwnedTable[] => {
  const pending = new Map(tables.map((owned) => [owned.table, owned]));
  const order: OwnedTable[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      ({ table }) =>
        !edges.some((e) => e.parent === table && e.child !== table && pending.has(e.child))
    );
    if (ready.length === 0) {
      throw new Error(
        `purgeOwnedRows: the foreign keys among ${[...pending.keys()].join(', ')} form a cycle, ` +
          'so no table can be deleted from first. Refusing rather than guessing.'
      );
    }
    for (const owned of ready) {
      order.push(owned);
      pending.delete(owned.table);
    }
  }
  return order;
};

/**
 * What keeps a parent row: any row still referencing it once this purge has deleted the
 * children it will delete. Children go first, so what remains is exactly what the purge is not
 * deleting — another player's, held, excepted, or kept for a child of its own — and deleting
 * the parent would take it by cascade. A self-reference reads through a `DISTINCT` derived
 * table, restricted to this purge's rows, because the `DELETE` targets that table (MySQL error
 * 1093; `RetentionHold` has the same rule).
 */
const cascadeGuard = (
  owned: OwnedTable,
  edges: readonly CascadeEdge[],
  dependents: ReadonlySet<string>,
  scope: OwnerScope,
  row: string
): Clause | null => {
  const parts: string[] = [];
  const params: unknown[] = [];
  const hasChildren = (table: string): boolean => edges.some((e) => e.parent === table);
  for (const edge of edges) {
    if (edge.parent !== owned.table) continue;
    if (dependents.has(edge.child) && !hasChildren(edge.child)) continue;
    const child = identifier(edge.child, 'a child table');
    const col = identifier(edge.column, 'a reference column');
    const parentCol = identifier(edge.parentColumn, 'a referenced column');
    if (edge.child === owned.table) {
      const bound = scope.owns('p', owned.column);
      parts.push(
        `NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT c.\`${col}\` AS \`k\` FROM \`${child}\` c ` +
          `JOIN \`${child}\` p ON p.\`${parentCol}\` = c.\`${col}\` WHERE ${bound.sql}) g ` +
          `WHERE g.\`k\` = ${row}.\`${parentCol}\`)`
      );
      params.push(...bound.params);
    } else {
      parts.push(
        `NOT EXISTS (SELECT 1 FROM \`${child}\` c WHERE c.\`${col}\` = ${row}.\`${parentCol}\`)`
      );
    }
  }
  return parts.length > 0 ? { sql: parts.join(' AND '), params } : null;
};

/**
 * Keep a row whose parent is under an open report *now* (MICA-168). The plan already keeps a
 * held parent's children, but a report filed between the plan and the `DELETE` would not: the
 * child goes first, checking only its own row's hold. So each child's statement also asks
 * whether any reportable parent it references is held, with retention's own `openReportHold`
 * over the parent. Read through a `DISTINCT` derived table bounded to this purge's rows, which
 * is also what makes a self-reference (a reply under a post) legal on MySQL (error 1093).
 */
const parentHold = (
  owned: OwnedTable,
  edges: readonly CascadeEdge[],
  scope: OwnerScope,
  row: string
): Clause | null => {
  const parts: string[] = [];
  const params: unknown[] = [];
  const child = identifier(owned.table, 'a child table');
  for (const edge of edges) {
    if (edge.child !== owned.table || !isReportableTable(edge.parent)) continue;
    const parent = identifier(edge.parent, 'a parent table');
    const col = identifier(edge.column, 'a reference column');
    const bound = scope.owns('cc', owned.column);
    const hold = openReportHold(parent, 'pp');
    parts.push(
      `NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT pp.\`id\` AS \`k\` FROM \`${parent}\` pp ` +
        `JOIN \`${child}\` cc ON cc.\`${col}\` = pp.\`id\` WHERE ${bound.sql} ` +
        `AND NOT (${hold.sql})) h WHERE h.\`k\` = ${row}.\`${col}\`)`
    );
    params.push(...bound.params, ...hold.params);
  }
  return parts.length > 0 ? { sql: parts.join(' AND '), params } : null;
};

const joined = (...clauses: (Clause | null)[]): Clause | null => {
  const present = clauses.filter((c): c is Clause => c !== null);
  if (present.length === 0) return null;
  return { sql: present.map((c) => c.sql).join(' AND '), params: present.flatMap((c) => c.params) };
};

/**
 * Test seam: runs once a purge has planned and before it deletes anything, so a suite can file
 * a report in exactly the window a real one could land in.
 */
let beforeDelete: (() => Promise<void>) | undefined;
export const __setPurgeHookForTests = (fn?: () => Promise<void>): void => {
  beforeDelete = fn;
};

const selectRows = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
  const rows = await Database.query(sql, params);
  if (!Array.isArray(rows)) throw new Error(`purgeOwnedRows: no rows came back for ${sql}`);
  return rows as T[];
};

/** Which of `ids` are still there, read back rather than inferred from a row count. */
const survivors = async (
  owned: OwnedTable,
  scope: OwnerScope,
  ids: readonly number[]
): Promise<number[]> => {
  const name = identifier(owned.table, 'a swept table');
  const left: number[] = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const bound = scope.owns('t', owned.column);
    const rows = await selectRows<{ id: unknown }>(
      `SELECT t.\`id\` AS \`id\` FROM ${name} t WHERE ${bound.sql} ` +
        `AND t.\`id\` IN (${chunk.map(() => '?').join(', ')})`,
      [...bound.params, ...chunk]
    );
    left.push(...rows.map((r) => Number(r.id)));
  }
  return left.sort((a, b) => a - b);
};

interface RowPlan {
  /** Ids this purge will delete. Only ever shrinks. */
  go: Set<number>;
  /** Ids kept as evidence: held, or hanging off a held row. Only ever grows. */
  evidence: Set<number>;
  /** The scope's rows that are not excepted, for `kept`. */
  counted: number;
}

interface Link {
  edge: CascadeEdge;
  /** Rows referencing the scope's rows in `edge.parent`; `id` null for an untracked table. */
  rows: { id: number | null; ref: number }[];
}

/**
 * The one delete behind all three callers (MICA-168, MICA-300): every row it removes is one it
 * chose, never one a cascade chose for it, and nothing it removes is evidence. `scope` says
 * whose rows these are (`OwnerScope`).
 *
 * 1. **Plan.** Each table's candidates are the scope's rows, less what the report hold and
 *    the caller's exceptions keep. A held row seeds the evidence set.
 * 2. **Links.** Every row referencing one of the scope's rows, through every foreign key but a
 *    named dependent's (`CascadeOptions.dependents`).
 * 3. **Settle**, until nothing changes. A row that stays keeps every row it references, since
 *    deleting that would cascade into it. A row hanging off evidence is evidence: the photo on
 *    a reported post, the attachment on a reported message, a reply under a reported post —
 *    retention's `liveReferences`, over the whole graph. The two rules only ever remove
 *    candidates, so this terminates.
 * 4. **Delete**, children first, by id and scope, with the hold and `cascadeGuard` still in
 *    the statement: a reply or a report that arrived after the plan keeps its row regardless.
 *    A table referencing itself goes in passes from the leaves up; running out of passes with
 *    rows left is a failure, never a silent keep.
 *
 * **A table that cannot be planned deletes nothing, and neither does anything under it.** Its
 * held rows are unknown, so the rows hanging off it might be evidence; a link that cannot be
 * read leaves both ends where they are. Each is a failure for its table, logged where it
 * happened, and every other table still goes — the character purge and the sweep always
 * worked table by table, and one missing table must not stop the rest. A plan that cannot be
 * made at all — a cycle, a key not on `id` — throws before any statement runs.
 */
export const purgePlanned = async (
  scope: OwnerScope,
  candidates: readonly OwnedTable[],
  options: PurgeOptions
): Promise<PlannedResult> => {
  const except = new Map((options.except ?? []).map((entry) => [entry.table, entry]));
  const dependents = new Set(options.cascade?.dependents ?? []);
  const edges = cascadeEdges();
  for (const edge of edges) {
    if (edge.parentColumn !== 'id') {
      throw new Error(
        `purgeOwnedRows: ${edge.child}.${edge.column} references ${edge.parent}.` +
          `${edge.parentColumn}, not its id, which the cascade plan cannot follow.`
      );
    }
  }
  const tables = candidates.filter(({ table }) => {
    const exception = except.get(table);
    return !exception || exception.keep !== undefined;
  });
  const order = childrenFirst(tables, edges);
  const byTable = new Map(order.map((owned) => [owned.table, owned]));
  const exempt = (child: string): boolean =>
    dependents.has(child) && !edges.some((e) => e.parent === child);

  const failed = new Map<string, unknown>();
  const fail = (table: string, error: unknown): void => {
    if (failed.has(table)) return;
    console.error(`[${scope.label}] purging ${table} ${scope.purpose} failed:`, error);
    failed.set(table, error);
  };
  /** Tables whose held rows, or whose rows' parents, are not known. */
  const unknown = new Set<string>();

  // 1. Plan.
  const plans = new Map<string, RowPlan>();
  for (const owned of order) {
    const plan: RowPlan = { go: new Set(), evidence: new Set(), counted: 0 };
    plans.set(owned.table, plan);
    try {
      const name = identifier(owned.table, 'a swept table');
      const exception = except.get(owned.table);
      const hold = evidenceHold(name, 't');
      const go = withKept(hold, exception, 't');
      const keep = exception?.keep?.('t');
      const bound = scope.owns('t', owned.column);
      const rows = await selectRows<{ id: unknown; go: unknown; held: unknown; ex: unknown }>(
        `SELECT t.\`id\` AS \`id\`, ` +
          `${go ? `CASE WHEN ${go.sql} THEN 1 ELSE 0 END` : '1'} AS \`go\`, ` +
          `${hold ? `CASE WHEN ${hold.sql} THEN 0 ELSE 1 END` : '0'} AS \`held\`, ` +
          `${keep ? `CASE WHEN ${keep.sql} THEN 1 ELSE 0 END` : '0'} AS \`ex\` ` +
          `FROM ${name} t WHERE ${bound.sql}`,
        [...(go?.params ?? []), ...(hold?.params ?? []), ...(keep?.params ?? []), ...bound.params]
      );
      for (const r of rows) {
        const id = Number(r.id);
        if (Number(r.go) === 1) plan.go.add(id);
        if (Number(r.held) === 1) plan.evidence.add(id);
        if (Number(r.ex) !== 1) plan.counted += 1;
      }
    } catch (error) {
      fail(owned.table, error);
      unknown.add(owned.table);
    }
  }

  // 2. Links.
  const links: Link[] = [];
  const frozen = new Set<string>();
  for (const edge of edges) {
    const parent = byTable.get(edge.parent);
    if (!parent || exempt(edge.child)) continue;
    const tracked = byTable.has(edge.child);
    try {
      const child = identifier(edge.child, 'a child table');
      const col = identifier(edge.column, 'a reference column');
      const parentName = identifier(edge.parent, 'a parent table');
      const bound = scope.owns('p', parent.column);
      const rows = await selectRows<{ id?: unknown; ref: unknown }>(
        `SELECT ${tracked ? 'c.`id` AS `id`, ' : ''}c.\`${col}\` AS \`ref\` FROM \`${child}\` c ` +
          `JOIN \`${parentName}\` p ON p.\`id\` = c.\`${col}\` WHERE ${bound.sql}`,
        bound.params
      );
      links.push({
        edge,
        rows: rows.map((r) => ({ id: tracked ? Number(r.id) : null, ref: Number(r.ref) }))
      });
    } catch (error) {
      // Which parents the child keeps, and which child rows hang off evidence, are unknown.
      fail(tracked ? edge.child : edge.parent, error);
      if (tracked) unknown.add(edge.child);
      frozen.add(edge.parent);
    }
  }

  // Everything under an unknown table stays: any of it might hang off a held row.
  for (const table of unknown) frozen.add(table);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of edges) {
      if (unknown.has(edge.parent) && byTable.has(edge.child) && !unknown.has(edge.child)) {
        unknown.add(edge.child);
        frozen.add(edge.child);
        grew = true;
      }
    }
  }
  for (const table of frozen) {
    plans.get(table)?.go.clear();
    if (!failed.has(table) && unknown.has(table)) {
      fail(
        table,
        new Error('not purged: a table its rows hang off could not be planned, so any may be held')
      );
    }
  }

  // 3. Settle.
  for (let changed = true; changed;) {
    changed = false;
    for (const { edge, rows } of links) {
      const parent = plans.get(edge.parent)!;
      const child = plans.get(edge.child);
      for (const { id, ref } of rows) {
        if (id !== null && child && parent.evidence.has(ref) && !child.evidence.has(id)) {
          child.evidence.add(id);
          child.go.delete(id);
          changed = true;
        }
        const childGoes = id !== null && child !== undefined && child.go.has(id);
        if (!childGoes && parent.go.delete(ref)) changed = true;
      }
    }
  }

  // A report filed now, between the plan and the delete, is what the next change guards.
  if (beforeDelete) await beforeDelete();

  // 4. Delete.
  let removed = 0;
  let kept = 0;
  const counts: Record<string, number> = {};
  for (const owned of order) {
    const plan = plans.get(owned.table)!;
    const ids = [...plan.go].sort((a, b) => a - b);
    const external = externals.get(owned.table);
    const refs: string[] = [];
    let deleted = 0;
    try {
      if (ids.length > 0) {
        const name = identifier(owned.table, 'a swept table');
        const exception = except.get(owned.table);
        const where = (row: string, chunk: readonly number[]) =>
          joined(
            scope.owns(row, owned.column),
            { sql: `${row}.\`id\` IN (${chunk.map(() => '?').join(', ')})`, params: [...chunk] },
            withKept(evidenceHold(name, row), exception, row),
            parentHold(owned, edges, scope, row),
            cascadeGuard(owned, edges, dependents, scope, row)
          )!;
        const selfReferencing = edges.some(
          (e) => e.parent === owned.table && e.child === owned.table
        );
        let settled = false;
        // What is still to delete. A table that references itself goes in passes, and each
        // pass re-reads which of these survived, so a deep chain costs depth × what is left
        // rather than depth × every id.
        let pending = ids;
        for (let pass = 0; pass < MAX_CHUNKS && !settled; pass++) {
          let round = 0;
          for (let i = 0; i < pending.length; i += DELETE_CHUNK) {
            const chunk = pending.slice(i, i + DELETE_CHUNK);
            if (external) {
              refs.push(...(await external.collect(where('t', chunk), COLLECT_LIMIT)));
            }
            const statement = where(name, chunk);
            round += affectedRows(
              await Database.query(`DELETE FROM ${name} WHERE ${statement.sql}`, statement.params)
            );
            await yieldToServer();
          }
          deleted += round;
          settled = !selfReferencing || round === 0 || deleted >= ids.length;
          if (!settled) pending = await survivors(owned, scope, pending);
        }
        if (!settled) {
          throw new Error(
            `stopped after ${MAX_CHUNKS} passes with ${pending.length} row(s) still to ` +
              'delete; the rest are left for another run, not counted as kept.'
          );
        }
      }
    } catch (error) {
      fail(owned.table, error);
    }
    removed += deleted;
    if (deleted > 0) counts[owned.table] = deleted;
    if (!failed.has(owned.table)) kept += plan.counted - deleted;
    if (external) await releaseCollected(scope.label, owned.table, external, refs);
  }

  const failures = [...failed].map(([table, error]) => ({ table, error }));
  return { removed, kept, failures, byTable: counts };
};
