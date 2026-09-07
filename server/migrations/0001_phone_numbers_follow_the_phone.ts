// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_phone_numbers';
const COLUMN = 'phone_id';
const PHONE_KEY = 'phone_id_unique';
const CITIZEN_KEY = 'citizenid_unique';
/** qb's own character table and the JSON column its phone number lives in. */
const PLAYERS = 'players';
const CHARINFO = 'charinfo';

/**
 * Does this table already carry a column of this name?
 *
 * Every DDL step below asks `information_schema` first rather than running blind, for the
 * reason the migrations before the flatten gave: `runMigrations` has an explicit path for
 * "it ran and recording it failed", which hands an operator the choice to retry, and a second
 * `ADD COLUMN` of something already there errors and aborts the rest of `micaschema apply`.
 */
const hasColumn = async (table: string, column: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(count) > 0;
};

/** Same question, for an index. Migrations do not share code; this is a copy on purpose. */
const hasIndex = async (table: string, index: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(count) > 0;
};

const rowCount = async (): Promise<number> =>
  Number(await Database.scalar<number>(`SELECT COUNT(*) FROM \`${TABLE}\``, []));

/**
 * The phone numbers qb characters already have, as `charinfo` stores them.
 *
 * `JSON_UNQUOTE(JSON_EXTRACT(...))` rather than `->>`, because MariaDB's `->>` is a
 * MySQL-compatibility shorthand that older builds lack, and the long form is what
 * `qbFindOfflineByPhone` already uses. `JSON_VALID` first: a `charinfo` that is not JSON — a
 * hand-edited row, a corrupted one — makes `JSON_EXTRACT` warn in some builds and error in
 * others, and a migration must not be the thing that finds out which. `'null'` is what
 * `JSON_UNQUOTE` renders a JSON null as. The length cap matches the column, because a value
 * the column cannot hold would truncate on a non-strict server rather than fail.
 *
 * A character who already has a row keeps it, whatever `charinfo` says — a server that ran
 * standalone before installing qb, or a retry after the ledger write failed. That is what
 * makes re-running the seed after `citizenid_unique` is gone a no-op rather than a second
 * row. The `NOT EXISTS` compares `players.citizenid` to micaOS's own column, which is the
 * column-to-column comparison `FrameworkBridge` avoids everywhere else over collations; it is
 * safe here and only here, because the foreign key from this table onto `players` already
 * requires the two to agree, or the schema would not have imported.
 */
const CHARINFO_NUMBERS = `
  SELECT \`citizenid\`, \`phone\` FROM (
    SELECT \`citizenid\`,
           JSON_UNQUOTE(JSON_EXTRACT(\`${CHARINFO}\`, '$.phone')) AS \`phone\`
      FROM \`${PLAYERS}\`
     WHERE JSON_VALID(\`${CHARINFO}\`)
  ) c
  WHERE \`phone\` IS NOT NULL
    AND \`phone\` <> ''
    AND \`phone\` <> 'null'
    AND CHAR_LENGTH(\`phone\`) <= 16
    AND NOT EXISTS (
      SELECT 1 FROM \`${TABLE}\` n WHERE n.\`citizenid\` = c.\`citizenid\`
    )`;

/**
 * MICA-284: a phone number belongs to the phone. This is the schema half of that, and the
 * part of the upgrade that has to happen in one pass with the code that widens number
 * ownership from standalone to every qb server — `services/PhoneNumbers.ts` is explicit that
 * both sources of a number must never be live at once.
 *
 * **Three things, in an order that matters.**
 *
 * 1. `phone_id` and its unique key are added, so the table is in its declared shape when
 *    this returns and the additive pass that follows finds nothing to do. Guarded, so a
 *    retry after a failed ledger write is a no-op rather than an error.
 *
 * 2. **Every existing qb character gets a legacy row carrying the number they already
 *    have**, read from `players.charinfo`. `phone_id` is left NULL because SQL cannot mint
 *    a phone id — that lives in inventory item metadata and exists only at runtime — so the
 *    row means "this citizen's number, not yet attached to a phone", and the first phone
 *    they use takes it. This runs **while `citizenid_unique` still stands**, so a character
 *    who somehow already has a row (a server that ran standalone before installing qb) keeps
 *    it, and `INSERT IGNORE` reads both keys as "skip" rather than as failure. Two
 *    characters sharing a `charinfo.phone` — which qb does not prevent — leave one of them
 *    without a row; they are issued a fresh number the first time they connect, it is written
 *    back into `charinfo`, and the count is printed here so the operator knows how many.
 *
 * 3. `citizenid_unique` is dropped last: a character holding two phones holds two numbers.
 *    This is the step that makes the whole thing a versioned migration — the additive planner
 *    never drops anything — and it is last so that a failure anywhere above leaves the old
 *    invariant in place for the retry.
 *
 * **On a database with no qb `players` table — es_extended, standalone — step 2 seeds
 * nothing**, and says so. ESX keeps its numbers on the character (there is no core column to
 * read, and no standard setter to write one back through), and standalone's rows already
 * exist and only need the new column. Nothing here reads `users`, and nothing here guesses at
 * a community phone resource's schema.
 *
 * **Safe to run twice.** Every DDL step asks `information_schema` first, and the seed skips
 * any character who already has a row, so a retry after the key is gone adds nothing.
 */
export const migration: Migration = {
  id: '0001_phone_numbers_follow_the_phone',
  description:
    `gives ${TABLE} a nullable ${COLUMN} with a unique key, seeds every existing qb ` +
    `character's charinfo.phone as a legacy row so nobody's number changes, and drops ` +
    `${CITIZEN_KEY} — a character holding two phones holds two numbers`,
  up: async () => {
    if (!(await hasColumn(TABLE, COLUMN))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD COLUMN \`${COLUMN}\` varchar(32) DEFAULT NULL`,
        []
      );
    }
    if (!(await hasIndex(TABLE, PHONE_KEY))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE KEY \`${PHONE_KEY}\` (\`${COLUMN}\`)`,
        []
      );
    }

    if (await hasColumn(PLAYERS, CHARINFO)) {
      const before = await rowCount();
      const eligible = Number(
        await Database.scalar<number>(`SELECT COUNT(*) FROM (${CHARINFO_NUMBERS}) n`, [])
      );
      await Database.query(
        `INSERT IGNORE INTO \`${TABLE}\` (\`citizenid\`, \`number\`) ${CHARINFO_NUMBERS}`,
        []
      );
      const seeded = (await rowCount()) - before;
      const skipped = eligible - seeded;
      console.log(
        `[mica] ${TABLE}: seeded ${seeded} legacy number${seeded === 1 ? '' : 's'} from ` +
          `${PLAYERS}.${CHARINFO}` +
          (skipped > 0
            ? `; ${skipped} skipped because the number, or the character, already had a row. ` +
              `A skipped character is issued a fresh number on their next connection and it ` +
              `is written back into ${CHARINFO}.`
            : '.')
      );
    } else {
      console.log(
        `[mica] ${TABLE}: no \`${PLAYERS}\`.\`${CHARINFO}\` here, so no numbers to seed. On ` +
          `es_extended the number stays on the character; on standalone the rows already exist.`
      );
    }

    if (await hasIndex(TABLE, CITIZEN_KEY)) {
      await Database.query(`ALTER TABLE \`${TABLE}\` DROP KEY \`${CITIZEN_KEY}\``, []);
    }
  }
};
