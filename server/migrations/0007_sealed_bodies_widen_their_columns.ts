// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * The widths, frozen: each column's plaintext bound sealed at four bytes a character with the
 * longest key id, as `sealedLengthForChars` computed it when this shipped — 500 characters for
 * a DM body, 300 for a report's preview. A migration means what it ran, whatever the
 * declarations say later.
 */
const WIDENINGS = [
  { table: 'mica_blabber_dms', column: 'body', width: 2726, nullable: false },
  { table: 'mica_reports', column: 'target_preview', width: 1662, nullable: true }
] as const;

/** A character set or collation name, as information_schema spells one, and nothing else. */
const CHARSET_NAME = /^[A-Za-z0-9_]+$/;

/**
 * MICA-165: a DM body and a report's preview are sealed at rest, and a sealed value is longer
 * than the text in it — `varchar(500)` and `varchar(300)` hold the plaintext and not its
 * sealed form. Each becomes as wide as its declared plaintext bound needs once sealed. The two
 * `text` columns (`mica_messages.message`, `mica_mail.content`) keep their type; their
 * plaintext bound came down instead.
 *
 * **In place, or not at all.** Both columns stay `varchar` and already need a two-byte length
 * prefix, so MySQL and MariaDB can widen them without touching a row. The statement says
 * `ALGORITHM=INPLACE, LOCK=NONE`, so a server that could not — an older engine, a column
 * someone moved to a single-byte charset by hand — refuses with an error the console shows,
 * rather than quietly copying a busy table under a lock while players wait on it.
 *
 * **The column's own character set and collation, restated.** `MODIFY COLUMN` without them
 * takes the table's defaults, which is the same thing on a table `mica.sql` created and not
 * necessarily on one a server owner converted; a widening must not also be a re-collation. So
 * both are read from the column and written back as they were.
 *
 * The planner cannot do this: a wider type is drift it reports and never touches. Safe to run
 * twice — each column is altered only while it is still narrower than its width — and a server
 * that never imported a table has nothing to change.
 */
export const migration: Migration = {
  id: '0007_sealed_bodies_widen_their_columns',
  description:
    'mica_blabber_dms.body and mica_reports.target_preview widen to hold their sealed form',
  up: async () => {
    for (const { table, column, width, nullable } of WIDENINGS) {
      const current = await Database.single<{
        type: string;
        chars: number | string | null;
        charset: string | null;
        collation: string | null;
      }>(
        `SELECT DATA_TYPE AS \`type\`, CHARACTER_MAXIMUM_LENGTH AS \`chars\`,
                CHARACTER_SET_NAME AS \`charset\`, COLLATION_NAME AS \`collation\`
           FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
      );
      if (!current) continue;
      if (String(current.type).toLowerCase() !== 'varchar') continue;
      if (Number(current.chars) >= width) continue;
      const charset = String(current.charset ?? '');
      const collation = String(current.collation ?? '');
      if (!CHARSET_NAME.test(charset) || !CHARSET_NAME.test(collation)) {
        throw new Error(
          `${table}.${column} reports character set '${charset}' and collation ` +
            `'${collation}', which this migration will not restate. Widen it by hand to ` +
            `varchar(${width}).`
        );
      }
      await Database.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` varchar(${width}) ` +
          `CHARACTER SET ${charset} COLLATE ${collation} ` +
          `${nullable ? 'DEFAULT NULL' : 'NOT NULL'}, ALGORITHM=INPLACE, LOCK=NONE`,
        []
      );
    }
  }
};
