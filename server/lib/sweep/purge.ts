// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { isReportableTable, recordOwnerDeletion } from '../moderation';
import { ERASED } from '../statuses';
import { identifier, type Clause } from './sql';
import { hasStatus, hasUpdatedAt, type OwnedTable } from './tables';
import type { OwnerScope } from './scope';
import { traceOf } from '../sqlErrors';

/**
 * How many rows one statement may move.
 *
 * An unbounded `UPDATE` across every table at boot holds row locks over the whole schema, and
 * every phone write on a busy server queues behind it. A `LIMIT` per statement bounds one
 * statement's lock footprint and lets the loop yield between batches.
 */
const ERASE_CHUNK = 500;

/**
 * How many statements one table gets in one run — a stop, not a target: 100,000 rows. Hitting it
 * is a failure for that table, said as one, and the next run carries on where this one stopped;
 * a boot-time task that never finishes is its own outage.
 */
const MAX_CHUNKS = 200;

export interface SweepFailure {
  table: string;
  error: unknown;
}

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown })?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

const yieldToServer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface PurgeException {
  table: string;
  /**
   * The rows to leave as they are, as SQL over the row qualifier `row`. Absent leaves the whole
   * table. Built by the caller from declared identifiers only; it is interpolated.
   */
  keep?: (row: string) => { sql: string; params: unknown[] };
}

export interface PurgeOptions {
  except?: readonly PurgeException[];
  /** Erase only these. Defaults to every owned table. */
  only?: readonly OwnedTable[];
  /** What a failure is logged as being for. Defaults to a player's own delete. */
  purpose?: string;
}

export interface PurgeResult {
  /** Rows this purge moved to `erased`. */
  erased: number;
  /**
   * Rows it left as they were: under a takedown (`moderated`), kept live by an exception — a
   * pending report the player filed, an invoice they owe — or a shared row other players are
   * still in (`registerSharedRows`). Not counted for a table that failed.
   */
  kept: number;
  failures: SweepFailure[];
}

interface PlannedResult extends PurgeResult {
  byTable: Record<string, number>;
}

/**
 * A table whose rows other players share through a membership table: a thread, a channel.
 * `members` is the membership table, `column` its reference to this table's `id`, `owner` its
 * owner column, `leftAt` the column whose `NULL` says a membership is live, and `kicked` the
 * status a membership is on when somebody removed the member from it.
 */
export interface SharedRows {
  members: string;
  column: string;
  owner: string;
  leftAt: string;
  kicked: string;
}

const shared = new Map<string, SharedRows>();

/**
 * Keep a shared row live while another player still has an `active` membership in it
 * (MICA-428). A purge erases what its owner made, but a group thread the owner started, or a
 * channel they opened, is also where everyone else in it reads and writes; erasing it would
 * hide the others' own messages from them. The owner's own membership and messages are erased
 * as usual, so they are out of it either way.
 *
 * **What happens to the row after that depends on who erased.** A deleted character's is erased
 * by the next orphan sweep once its last other member has gone. A privacy delete's is not: its
 * owner still exists, so no orphan sweep ever reaches it, and the thread or channel simply stays
 * `active`, theirs on paper, for as long as anyone is in it and after. That is the behaviour,
 * on purpose for now; what an owner who deleted their data still holds over a channel they
 * opened is its own question.
 *
 * Registered by the owning service, once — `server/lib` names no service's table itself.
 */
export const registerSharedRows = (table: string, rows: SharedRows): void => {
  identifier(table, 'a shared table');
  identifier(rows.members, 'a membership table');
  identifier(rows.column, 'a membership column');
  identifier(rows.owner, 'a membership owner column');
  identifier(rows.leftAt, 'a membership left column');
  if (!/^[a-z_]+$/.test(rows.kicked)) {
    throw new Error(`registerSharedRows: '${rows.kicked}' is not a status.`);
  }
  if (shared.has(table)) throw new Error(`registerSharedRows: '${table}' is already registered.`);
  shared.set(table, rows);
};

/**
 * What else an erase writes on a membership table: the time it was left, unless it already was.
 * Membership is read as `left_at IS NULL` everywhere it is asked — a thread's members, a 1:1's
 * pair, a channel's one live seat per citizen and its aliases — so a membership erased but not
 * left would keep an erased player in every thread they were in. Left now, it reads as the
 * player having gone, which they have. An earlier leave keeps its own time.
 */
const leaving = (table: string): string => {
  const rows = membershipOf(table);
  return rows ? `, \`${rows.leftAt}\` = COALESCE(\`${rows.leftAt}\`, CURRENT_TIMESTAMP)` : '';
};

/** The shared rows `table` is the membership table of, or null. */
const membershipOf = (table: string): SharedRows | null => {
  for (const rows of shared.values()) if (rows.members === table) return rows;
  return null;
};

/** Another owner's live membership in the row, as SQL over the row qualifier `row`. */
const othersInIt = (scope: OwnerScope, table: string, row: string): Clause | null => {
  const rows = shared.get(table);
  if (!rows) return null;
  const mine = scope.owns('sm', rows.owner);
  return {
    sql:
      `NOT EXISTS (SELECT 1 FROM \`${rows.members}\` sm WHERE sm.\`${rows.column}\` = ${row}.\`id\` ` +
      `AND sm.\`status\` = 'active' AND NOT (${mine.sql}))`,
    params: [...mine.params]
  };
};

/**
 * Test seam: runs once before the first statement, so a suite can take a row down in exactly
 * the window a real takedown could land in.
 */
let beforeErase: (() => Promise<void>) | undefined;
export const __setPurgeHookForTests = (fn?: () => Promise<void>): void => {
  beforeErase = fn;
};

const selectIds = async (sql: string, params: unknown[]): Promise<number[]> => {
  const rows = await Database.query(sql, params);
  if (!Array.isArray(rows)) throw new Error(`purgeOwnedRows: no rows came back for ${sql}`);
  return (rows as { id: unknown }[])
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
};

const and = (...clauses: (Clause | null | undefined)[]): Clause => {
  const present = clauses.filter((c): c is Clause => c !== null && c !== undefined);
  return { sql: present.map((c) => c.sql).join(' AND '), params: present.flatMap((c) => c.params) };
};

/**
 * Every row `scope` owns, moved to `erased` (MICA-428): the one write behind the privacy
 * delete, the character-deleted purge, the orphan sweep and the media-only purges. Nothing is
 * ever deleted. The rows stay, for staff and for evidence, and no player — the owner included —
 * sees an erased row again.
 *
 * Per status table, one statement shape:
 *
 *   `UPDATE t SET status = 'erased', updated_at = updated_at
 *    WHERE <scope owns> AND status NOT IN ('moderated', 'erased') [AND NOT <keep>] LIMIT n`
 *
 * repeated until a statement moves fewer than `n`. `updated_at` is pinned, as a takedown's is:
 * erasing is not an edit. A child table with no `updated_at` (`mica_darkchat_members`) has
 * nothing to pin, and naming one would be an unknown column. Every status but `moderated` moves — `active`, `archived`, the
 * player's own `deleted`, a membership `left`, a window's `expired` — because what the owner
 * asked for is that none of it is theirs to see or anyone else's.
 *
 * **A takedown holds its row** (MICA-426). A `moderated` row stays as it is, and each takedown
 * holding one of the scope's rows is then told the owner erased it, so a reopen restores
 * `erased`, not what it recorded. The read comes **after** the write, which is what closes the
 * window MICA-426 left between a purge's plan and its delete: a takedown that lands before the
 * `UPDATE` leaves a `moderated` row this read finds, and one that lands after it finds the row
 * already `erased` and records that itself. Only reportable tables, the only ones a takedown
 * can name.
 *
 * **A shared row stays while others are in it** (`registerSharedRows`): a thread or a channel
 * the owner started is where its other members read their own messages. The owner's own
 * membership in it is erased and left (`leaving`).
 *
 * Status-less tables are left alone — a follow, a reaction, a swipe has no status to move yet
 * (MICA-429). There is no cascade to plan: an `UPDATE` reaches no other row.
 *
 * A table that fails is a failure for that table, logged where it happened, and every other
 * table still goes — the character purge and the sweep always worked table by table, and one
 * missing table must not stop the rest.
 */
export const purgePlanned = async (
  scope: OwnerScope,
  candidates: readonly OwnedTable[],
  options: PurgeOptions
): Promise<PlannedResult> => {
  const except = new Map((options.except ?? []).map((entry) => [entry.table, entry]));
  const tables = candidates.filter(({ table }) => {
    if (!hasStatus(table)) return false;
    const exception = except.get(table);
    return !exception || exception.keep !== undefined;
  });

  const failures: SweepFailure[] = [];
  const fail = (table: string, error: unknown): void => {
    console.error(`[${scope.label}] erasing ${table} ${scope.purpose} failed:`, traceOf(error));
    failures.push({ table, error });
  };

  if (beforeErase) await beforeErase();

  let erased = 0;
  let kept = 0;
  const byTable: Record<string, number> = {};
  for (const owned of tables) {
    let moved = 0;
    try {
      const name = `\`${identifier(owned.table, 'an erased table')}\``;
      // Pinned where the table has one, so erasing is not an edit; a child table may not.
      const pin =
        (hasUpdatedAt(owned.table) ? ', `updated_at` = `updated_at`' : '') + leaving(owned.table);
      const keep = except.get(owned.table)?.keep?.(name);
      /**
       * A kick is not overwritten (MICA-428 review): a membership somebody removed the member
       * from keeps `removed`, which is what refuses their rejoin, and is only marked left
       * (below). Every other status — sold, declined, settled, a player's own `deleted` — moves
       * to `erased`; the row is kept either way.
       */
      const membership = membershipOf(owned.table);
      const spared = membership ? [ERASED, membership.kicked] : [ERASED];
      const where = and(
        scope.owns(name, owned.column),
        {
          sql: `${name}.\`status\` NOT IN ('moderated', ${spared.map(() => '?').join(', ')})`,
          params: spared
        },
        keep && { sql: `NOT (${keep.sql})`, params: keep.params },
        othersInIt(scope, owned.table, name)
      );
      let settled = false;
      for (let chunk = 0; chunk < MAX_CHUNKS && !settled; chunk++) {
        const round = affectedRows(
          await Database.query(
            `UPDATE ${name} SET \`status\` = ?${pin} WHERE ${where.sql} LIMIT ${ERASE_CHUNK}`,
            [ERASED, ...where.params]
          )
        );
        moved += round;
        settled = round < ERASE_CHUNK;
        if (!settled) await yieldToServer();
      }
      if (!settled) {
        throw new Error(
          `stopped after ${MAX_CHUNKS * ERASE_CHUNK} rows; the rest are left for the next run.`
        );
      }

      // A kicked membership the erase spared is still the owner's to leave: marked left, its
      // status kept. One statement, never a chunk loop: it moves only rows with no left time.
      if (membership) {
        const kicked = scope.owns(name, owned.column);
        const keepEdited = hasUpdatedAt(owned.table) ? ', `updated_at` = `updated_at`' : '';
        await Database.query(
          `UPDATE ${name} SET \`${membership.leftAt}\` = CURRENT_TIMESTAMP${keepEdited} ` +
            `WHERE ${kicked.sql} AND ${name}.\`status\` = ? AND ${name}.\`${membership.leftAt}\` IS NULL`,
          [...kicked.params, membership.kicked]
        );
      }

      // After the write, so a takedown that landed before it is found here (MICA-426).
      const owns = scope.owns(name, owned.column);
      const held = isReportableTable(owned.table)
        ? await selectIds(
            `SELECT ${name}.\`id\` AS \`id\` FROM ${name} ` +
              `WHERE ${owns.sql} AND ${name}.\`status\` = 'moderated'`,
            owns.params
          )
        : [];
      if (held.length > 0) await recordOwnerDeletion(owned.table, held, ERASED);
      // What is left as it was: a takedown's row, an exception's, a shared one others are in.
      kept += Number(
        (await Database.scalar<unknown>(
          `SELECT COUNT(*) FROM ${name} WHERE ${owns.sql} AND ${name}.\`status\` <> ?`,
          [...owns.params, ERASED]
        )) ?? 0
      );
    } catch (error) {
      fail(owned.table, error);
    }
    erased += moved;
    if (moved > 0) byTable[owned.table] = moved;
  }

  return { erased, kept, failures, byTable };
};
