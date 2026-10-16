// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_blabber';
const COLUMN = 'mouth_key';
const KEY = 'account_mouth_key';
const OLD_KEY = 'account_mouth';

/**
 * `mouth_key` as `Blabber.ts` declared it when this shipped, frozen: a migration means what it
 * ran, whatever the declaration says later. Restated rather than imported, because a migration
 * must not import a service module whose shape can move out from under it.
 */
const MOUTH_KEY_DDL =
  "`mouth_key` int(11) GENERATED ALWAYS AS (CASE WHEN `status` <> 'deleted' THEN `mouth_of` " +
  'ELSE NULL END) VIRTUAL';

/** Migrations do not share code; these are copies on purpose, as 0001's are. */
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

const hasIndex = async (table: string, index: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index]
    )
  ) > 0;

/**
 * MICA-330: a deleted mouth no longer holds its slot. `account_mouth (account_id, mouth_of)`
 * ignored `status`, and a Blab's delete is soft, so mouthing a Blab, deleting the mouth and
 * mouthing it again was refused as "You have already mouthed that". `mica_blabber` gains
 * `mouth_key` — `mouth_of` unless the row is `'deleted'`, `NULL` then — and `account_mouth_key`
 * over `(account_id, mouth_key)` replaces `account_mouth`. The technique is `phone_key`'s
 * (0010): a unique key never collides on `NULL`, so a deleted mouth holds no key. A moderated
 * one keeps it, so reopening its report can put it back without meeting a re-mouth.
 *
 * **No duplicates to settle, unlike 0010.** The old key is strictly stronger than the new one:
 * two rows the new key calls equal share an account and a non-`NULL` `mouth_of`, which the old
 * key already refused. So the new key is added first and the old one dropped after, and at no
 * point is the table without a constraint a live server's double tap would hit. A database
 * that somehow lost `account_mouth` and holds duplicates has the `ADD UNIQUE KEY` refused with
 * ER 1062, which stops `micaschema apply` before the old key is touched.
 *
 * Dropping `account_mouth` costs no foreign key its index: `account_id` has its own key, and
 * `mouth_of`'s foreign key never could use one led by `account_id`.
 *
 * **Safe to run twice**: the column and both keys are each asked for first. A table this server
 * never created is skipped.
 */
export const migration: Migration = {
  id: '0012_blabber_mouths_unique_while_live',
  description:
    "mica_blabber gains mouth_key, NULL on 'deleted', and account_mouth_key over it replaces " +
    'account_mouth, so a deleted mouth no longer refuses the same Blab mouthed again',
  up: async () => {
    if (!(await hasTable(TABLE))) return;
    if (!(await hasColumn(TABLE, COLUMN))) {
      await Database.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${MOUTH_KEY_DDL}`, []);
    }
    if (!(await hasIndex(TABLE, KEY))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE KEY \`${KEY}\` (\`account_id\`, \`${COLUMN}\`)`,
        []
      );
    }
    if (await hasIndex(TABLE, OLD_KEY)) {
      await Database.query(`ALTER TABLE \`${TABLE}\` DROP KEY \`${OLD_KEY}\``, []);
    }
  }
};
