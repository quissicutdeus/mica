// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const PARTICIPANTS = 'gos_messages_participants';
const OLD_INDEX = 'conversation_participant';
const UNIQUE_INDEX = 'conversation_participant_unique';

/**
 * Does this table already carry an index of this name?
 *
 * Every DDL step below is guarded on this rather than run blind, because a migration has to
 * survive being run twice. The ledger normally prevents that, but `runMigrations` has an
 * explicit path for "it ran and recording it failed", which hands an operator the decision
 * to retry — and a second `ADD UNIQUE KEY` or a `DROP INDEX` of something already gone errors
 * and aborts the rest of `gosschema apply`. `table_schema = DATABASE()` confines the
 * question to the schema this resource is connected to.
 */
const hasIndex = async (table: string, index: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(count) > 0;
};

/**
 * Repair the rows MICA-153 let anyone write, then put the constraint that stops them
 * being written again — in that order, because the constraint cannot be added over the
 * rows it forbids.
 *
 * **This migration deletes rows**, and outside `gosmedia prune` it is the only thing in
 * this resource that does. Only surplus participant rows go: rows naming a person a second
 * or five-hundredth time in a thread they are already in, which the bug wrote and nobody
 * asked for. No conversation and no message is touched.
 *
 * **Why a unique index after all.** The ticket proposed one and then argued itself out of
 * it, on the grounds that `UNIQUE (conversation_id, citizenid)` would break rejoining: a
 * player leaves, `left_at` is stamped, and coming back inserts a second row. That is not
 * what the code does. `addParticipant` is called from two places, both inside `create`, and
 * there is no add-member action registered at all — leaving a thread and messaging that
 * person again produces a *new* conversation with a new id, which the key does not touch.
 * So there is no rejoin for the constraint to refuse.
 *
 * The alternative the ticket floated is worse than useless: putting `left_at` in the key
 * constrains nothing, because MySQL treats NULLs as distinct and every live row has one.
 * Unlimited live rows would still be allowed, and live rows are exactly the set every
 * membership query reads.
 *
 * **Safe to run twice.** The row repairs are written so they match nothing once applied,
 * and both DDL steps ask `information_schema` first.
 */
export const migration: Migration = {
  id: '0001_repair_conversation_participants',
  description:
    'deletes duplicate participant rows, recomputes gos_messages_conversations.is_group from the live participant count, and replaces the conversation_participant index with a unique one',
  up: async () => {
    /**
     * Keep one row for each person in each thread and delete the rest.
     *
     * **Deleted, not closed.** An earlier draft stamped `left_at` and `status = 'removed'`
     * on the surplus rows, and that cannot work: `UNIQUE (conversation_id, citizenid)` has
     * no `left_at` component — deliberately, per the note above — so it counts rows, not
     * live rows. Five hundred soft-closed rows still collide, and the `ADD UNIQUE KEY`
     * below fails with ER 1062 on the first server that has any. The two facts are each
     * correct and mutually exclusive: the closed duplicates cannot be retained *and* the
     * pair constrained. They are artefacts of a bug rather than history — nobody chose to
     * create them — and `removeParticipant` still records the case where somebody really
     * did leave, so nothing meaningful is lost by removing them.
     *
     * **Every row counts here, not just the live ones.** The dedup this replaces filtered
     * on `left_at IS NULL`, which misses a state the ticket itself describes: because
     * `removeParticipant` has no `LIMIT`, a victim who leaves a thread closes all five
     * hundred of their rows at once. Those rows are then invisible to a live-only filter
     * and still violate the key.
     *
     * Which row survives matters. `MIN(CASE WHEN left_at IS NULL THEN id END)` is the
     * earliest row that is still live, and it wins whenever one exists, so somebody
     * currently in a thread is never dropped out of it by having their live row deleted in
     * favour of an older closed one. `COALESCE` falls back to the earliest row overall for
     * a pair that has already left entirely, which keeps their `left_at` history.
     *
     * The aggregate in the derived table also stops MySQL merging it into the outer DELETE,
     * which is what would otherwise raise ER 1093 for reading the table being written.
     * `MIN` rather than a window function because MariaDB 10.1 is still in the field and
     * has none.
     */
    await Database.query(
      `DELETE p FROM ${PARTICIPANTS} p
         JOIN (
                SELECT conversation_id,
                       citizenid,
                       COALESCE(
                         MIN(CASE WHEN left_at IS NULL THEN id END),
                         MIN(id)
                       ) AS keep_id
                  FROM ${PARTICIPANTS}
                 GROUP BY conversation_id, citizenid
                HAVING COUNT(*) > 1
              ) duplicated
           ON duplicated.conversation_id = p.conversation_id
          AND duplicated.citizenid = p.citizenid
        WHERE p.id <> duplicated.keep_id`,
      []
    );

    /**
     * Recompute `is_group` from who is actually in each thread.
     *
     * **This has to run after the delete above.** A thread holding one victim on 500
     * duplicate rows counts as 500 live participants, so recomputing first would stamp
     * `is_group = 1` on a genuine one-to-one and replace one wrong answer with another.
     * Ordering inside `up()` is the whole reason these are one migration.
     *
     * Repairing this is what makes an already-forged thread visible: the Messages UI hides
     * the member list, the group heading and every sender name while `is_group` is 0, so a
     * thread stood up with a silent third participant keeps concealing them until the flag
     * is corrected, however the server behaves from now on.
     *
     * `updated_at` is assigned to itself so MySQL's `ON UPDATE CURRENT_TIMESTAMP` does not
     * fire: it is the sort key for every player's thread list, and a repair should not
     * reorder inboxes. Threads with no live participants match no row and are left alone.
     */
    await Database.query(
      `UPDATE gos_messages_conversations c
         JOIN (
                SELECT conversation_id, COUNT(*) AS live_members
                  FROM ${PARTICIPANTS}
                 WHERE left_at IS NULL
                 GROUP BY conversation_id
              ) live
           ON live.conversation_id = c.id
          SET c.is_group = IF(live.live_members > 2, 1, 0),
              c.updated_at = c.updated_at
        WHERE c.is_group <> IF(live.live_members > 2, 1, 0)`,
      []
    );

    /**
     * Swap the non-unique index for the unique one, explicitly, and **add before dropping**.
     *
     * The order is the failure-mode question, not a style one. Dropping first and then
     * failing to add — which is exactly what ER 1062 did on a table still holding
     * duplicates — leaves the table with no `(conversation_id, citizenid)` index at all:
     * slower than before the upgrade, still unprotected, with two repairs already committed
     * and `gosschema apply` aborted. Adding first means a failure leaves the table
     * exactly as it was found. It also means the `conversation_id` foreign key never sits
     * without a usable index for even one statement.
     *
     * Doing the swap here at all, rather than leaving it to the additive pass, is because
     * that planner compares live indexes **by name only** — `server/lib/migrate.ts` never
     * looks at whether one is unique. Renaming is what lets it notice; doing the work here
     * means an upgraded server does not depend on it. A check that passes without having
     * run is the failure this repo names explicitly, and an index silently non-unique on
     * every pre-existing server would have been exactly that.
     */
    if (!(await hasIndex(PARTICIPANTS, UNIQUE_INDEX))) {
      await Database.query(
        `ALTER TABLE \`${PARTICIPANTS}\`
           ADD UNIQUE KEY \`${UNIQUE_INDEX}\` (\`conversation_id\`, \`citizenid\`)`,
        []
      );
    }

    if (await hasIndex(PARTICIPANTS, OLD_INDEX)) {
      await Database.query(`ALTER TABLE \`${PARTICIPANTS}\` DROP INDEX \`${OLD_INDEX}\``, []);
    }
  }
};
