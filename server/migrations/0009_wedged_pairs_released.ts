// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/** The two tables and the line prefix, frozen: what they were called when this shipped. */
const CONVERSATIONS = 'mica_messages_conversations';
const PARTICIPANTS = 'mica_messages_participants';
const LINE_PREFIX = 'ext:';

/** Every column the statement names, per table. A table missing one is not a state this knows. */
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [CONVERSATIONS]: ['id', 'is_group', 'status', 'participant_a', 'participant_b', 'updated_at'],
  [PARTICIPANTS]: ['conversation_id', 'device_id', 'left_at']
};

/** Migrations do not share code; these are copies on purpose, as 0008's are. */
const hasTable = async (table: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.TABLES
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    )
  ) > 0;

const hasColumn = async (table: string, column: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    )
  ) > 0;

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

/**
 * MICA-342: release the 1:1 threads a side left before the fix, so the two can talk again.
 *
 * `pair_key_unique` holds a 1:1's pair while the row is `active`. `findOneToOne` matches a
 * pair only while both phones are still in the thread. Before MICA-342, a side leaving a 1:1
 * (the non-admin `delete`) or taken out by a privacy delete left the thread active for the
 * other side, still holding the key. Every new thread between the two was then a duplicate
 * key, which reached either player only as "something went wrong", and nothing would ever
 * free it. Since the fix, `ConversationRepository.releasePair` and `releasePairsOf` null the
 * pair columns as the side goes. This does the same for the threads left before that.
 *
 * **What is released:** an active 1:1 with both pair columns set, neither one a line's `ext:`
 * key, where at least one of the two phones has no live membership (`left_at IS NULL`) in that
 * thread. Both pair columns become NULL, so the generated `pair_key` is NULL, and `updated_at` is
 * pinned so nobody's inbox reorders. The thread stays active, and so do its members and every
 * text in it. Only the key goes.
 *
 * **What is not:** a healthy pair, whose phones are both still in it. A group, which has no
 * pair. A thread with a line, which `findExternalThread` finds by these columns and
 * `ensureLineParticipant` reopens, so a line's thread whose player left must keep them. A thread
 * that is not active, whose key is already NULL.
 *
 * A thread whose second membership has not been written yet looks exactly like a wedged one.
 * If `micaschema apply` runs while a `create` is in flight, that thread loses its key. Its
 * members are still written, `findOneToOne` still finds it by membership, and
 * `reconcilePairDuplicate` still settles a race, so the only loss is the insert race guard.
 *
 * **Safe to run twice.** A second run finds no thread with both pair columns set and a side
 * missing. A server that never imported either table is skipped. A table missing a column this
 * names stops the migration, unrecorded, with the column named, rather than guessing.
 */
export const migration: Migration = {
  id: '0009_wedged_pairs_released',
  description:
    `releases the pair key of every active 1:1 in ${CONVERSATIONS} that one side has left, ` +
    'so the two can start a thread with each other again',
  up: async () => {
    for (const table of Object.keys(COLUMNS)) {
      if (!(await hasTable(table))) return;
    }
    for (const [table, columns] of Object.entries(COLUMNS)) {
      for (const column of columns) {
        if (!(await hasColumn(table, column))) {
          throw new Error(
            `${table} has no ${column} column. No thread was released; bring the table to ` +
              'the shape this migration expects and run micaschema apply again.'
          );
        }
      }
    }

    const live = (side: string) =>
      `EXISTS (SELECT 1 FROM \`${PARTICIPANTS}\` p
                WHERE p.\`conversation_id\` = c.\`id\` AND p.\`device_id\` = c.\`${side}\`
                  AND p.\`left_at\` IS NULL)`;
    const line = `${LINE_PREFIX}%`;
    const result = await Database.query(
      `UPDATE \`${CONVERSATIONS}\` c
          SET c.\`participant_a\` = NULL, c.\`participant_b\` = NULL,
              c.\`updated_at\` = c.\`updated_at\`
        WHERE c.\`is_group\` = 0 AND c.\`status\` = 'active'
          AND c.\`participant_a\` IS NOT NULL AND c.\`participant_b\` IS NOT NULL
          AND c.\`participant_a\` NOT LIKE ? AND c.\`participant_b\` NOT LIKE ?
          AND NOT (${live('participant_a')} AND ${live('participant_b')})`,
      [line, line]
    );
    console.log(
      `[mica] released the pair of ${affectedRows(result)} 1:1 thread(s) one side had left.`
    );
  }
};
