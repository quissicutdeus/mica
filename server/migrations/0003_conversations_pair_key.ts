// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_messages_conversations';
const PARTICIPANTS = 'mica_messages_participants';
const INDEX = 'pair_key_unique';

/**
 * Does this table already carry a column of this name?
 *
 * Same reasoning `0001`'s `hasIndex` gives for guarding every DDL step rather than running
 * it blind: `runMigrations` has an explicit path for "it ran and recording it failed", which
 * hands an operator the choice to retry, and a second `ADD COLUMN` of something already
 * there errors and aborts the rest of `micaschema apply`.
 */
const hasColumn = async (table: string, column: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(count) > 0;
};

/** Same question, for an index. Identical to `0001`'s helper; migrations do not share code. */
const hasIndex = async (table: string, index: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(count) > 0;
};

/**
 * MICA-161, the second half of MICA-156: give a 1:1 conversation a normalised pair key
 * so the database, not a post-hoc reconciliation, refuses two active threads for the same
 * two people.
 *
 * **Four steps, in this order, because each one needs the last.** `participant_a`/
 * `participant_b` have to exist before anything can be written into them; they have to be
 * backfilled before the generated column can compute anything from them; the generated
 * column has to exist before an index can be added to it; and whether that index can be
 * `UNIQUE` is a question about the data the backfill just produced; each step depends on
 * the one before it having already run, on this connection, in this `up()`.
 *
 * **The backfill is not a guess.** A conversation this service created as a 1:1
 * (`is_group = 0`) has, after `0001`'s repair, exactly the participants it actually has —
 * no forged third party, no thousand-row duplicate. `MIN`/`MAX` of the joined participants'
 * citizenids, restricted to threads with exactly two distinct ones, is simply *the pair*;
 * which one lands in `participant_a` versus `participant_b` does not matter, because
 * `pair_key`'s `LEAST`/`GREATEST` normalises the order regardless. `updated_at = updated_at`
 * keeps the backfill from reordering anyone's inbox, the same convention `0001` uses.
 *
 * **The expression is mirrored by hand from `server/services/Conversations.ts`'s
 * `pair_key.generatedAs`, not imported.** A migration is frozen at the moment it ships;
 * importing a service module whose schema can change out from under it would make a past
 * migration mean something different than what it actually ran. Keep the two in sync by
 * eye if the expression ever needs to change — which itself would need a *new* migration,
 * since a generated column's expression is exactly the kind of change `SchemaMigrator`
 * cannot verify from `information_schema` (see `server/lib/migrate.ts`'s `generatedAs`
 * skip) and therefore cannot apply on its own.
 *
 * **The unique-vs-plain decision is the real reason this is a migration and not just an
 * additive column.** A `UNIQUE KEY` cannot be added over rows that already violate it —
 * two existing 1:1 threads for the same pair, surviving from before any reconciliation
 * existed, one or both possibly holding real messages. This is not a repair migration: it
 * does not merge them, because a merge that mishandles which thread's read state or history
 * is authoritative corrupts something a player can see, silently. So the constraint the
 * declaration asks for (`unique: true` in `Conversations.ts`) is added only when the
 * backfill produced no collision; a server carrying a pre-existing duplicate gets a plain,
 * non-unique index under the **same name** instead. `SchemaMigrator`'s additive pass
 * compares live indexes by name only, never by uniqueness, so a later `micaschema apply`
 * on that same server finds `pair_key_unique` already present and leaves it exactly as this
 * migration left it, rather than retrying an `ADD UNIQUE KEY` that would fail identically,
 * and for the same reason, every single time.
 *
 * **Safe to run twice.** Every step asks `information_schema` first, and the backfill only
 * ever touches rows still holding `NULL` in both new columns.
 */
export const migration: Migration = {
  id: '0003_conversations_pair_key',
  description:
    'adds mica_messages_conversations.participant_a/participant_b, backfills them for ' +
    'existing one-to-one threads, adds the generated pair_key column, and indexes it — ' +
    'uniquely where no existing pair already collides, or as a plain index otherwise',
  up: async () => {
    if (!(await hasColumn(TABLE, 'participant_a'))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD COLUMN \`participant_a\` varchar(50) DEFAULT NULL`,
        []
      );
    }
    if (!(await hasColumn(TABLE, 'participant_b'))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD COLUMN \`participant_b\` varchar(50) DEFAULT NULL`,
        []
      );
    }

    await Database.query(
      `UPDATE \`${TABLE}\` c
         JOIN (
                SELECT conversation_id,
                       MIN(citizenid) AS a,
                       MAX(citizenid) AS b
                  FROM \`${PARTICIPANTS}\`
                 GROUP BY conversation_id
                HAVING COUNT(DISTINCT citizenid) = 2
              ) pair ON pair.conversation_id = c.id
          SET c.participant_a = pair.a,
              c.participant_b = pair.b,
              c.updated_at = c.updated_at
        WHERE c.is_group = 0
          AND c.participant_a IS NULL
          AND c.participant_b IS NULL`,
      []
    );

    if (!(await hasColumn(TABLE, 'pair_key'))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD COLUMN \`pair_key\` varchar(101) GENERATED ALWAYS AS (
           CASE WHEN \`status\` = 'active'
                THEN CONCAT(LEAST(\`participant_a\`, \`participant_b\`), '|', GREATEST(\`participant_a\`, \`participant_b\`))
                ELSE NULL
           END
         ) VIRTUAL`,
        []
      );
    }

    if (!(await hasIndex(TABLE, INDEX))) {
      const duplicates = await Database.scalar<number>(
        `SELECT COUNT(*) FROM (
                SELECT pair_key FROM \`${TABLE}\`
                 WHERE pair_key IS NOT NULL
                 GROUP BY pair_key
                HAVING COUNT(*) > 1
              ) dupes`,
        []
      );

      const keyword = Number(duplicates) > 0 ? 'KEY' : 'UNIQUE KEY';
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD ${keyword} \`${INDEX}\` (\`pair_key\`)`,
        []
      );
    }
  }
};
