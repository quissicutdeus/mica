// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_contacts';
const COLUMN = 'phone_key';
const KEY = 'device_phone_unique';

/**
 * `phone_key` as `Contacts.ts` declared it when this shipped, frozen: a migration means what it
 * ran, whatever the declaration says later. Restated rather than imported, because a migration
 * must not import a service module whose shape can move out from under it.
 */
const PHONE_KEY_DDL =
  "`phone_key` varchar(20) GENERATED ALWAYS AS (CASE WHEN `status` = 'active' THEN `phone` " +
  'ELSE NULL END) VIRTUAL';

/** How many ids go into one `UPDATE … WHERE id IN (…)`. */
const CHUNK = 500;
/** How many of the settled ids the log line names; past it, a count. */
const LOGGED_IDS = 100;

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
 * Every live contact that another live contact on the same phone, with the same number, beats.
 *
 * Joined on `phone_key` rather than `phone`, so two rows are the same number here exactly when
 * the key about to be added would call them the same: under that column's collation, and only
 * while both are `'active'` (it is `NULL` otherwise, and `NULL` joins nothing). A `NULL`
 * `device_id` joins nothing either, as it collides with nothing under the key.
 *
 * Which row is kept, per phone and number: the favourite, then the one edited last, then the
 * newest. A total order — `id` is unique — so exactly one row in each group is beaten by
 * nobody, and every other one is beaten by at least that one.
 */
const BEATEN = `
  SELECT DISTINCT loser.\`id\` AS \`id\`
    FROM \`${TABLE}\` loser
    JOIN \`${TABLE}\` keeper
      ON keeper.\`device_id\` = loser.\`device_id\`
     AND keeper.\`${COLUMN}\` = loser.\`${COLUMN}\`
     AND keeper.\`id\` <> loser.\`id\`
   WHERE (COALESCE(keeper.\`favorite\`, 0), keeper.\`updated_at\`, keeper.\`id\`)
       > (COALESCE(loser.\`favorite\`, 0), loser.\`updated_at\`, loser.\`id\`)
   ORDER BY loser.\`id\``;

/**
 * MICA-335: one live contact per number on a phone. `mica_contacts` gains `phone_key` — `phone`
 * while the row is `'active'`, `NULL` otherwise — and `device_phone_unique` over
 * `(device_id, phone_key)`, which closes the default-contacts seed's race with a player saving
 * the same number (the second insert is refused rather than written beside the first).
 *
 * **Duplicates first, or the key aborts on ER 1062**, as MICA-153's did. Only live contacts can
 * collide: a deleted or moderated row's `phone_key` is `NULL`, so the common case — a contact
 * deleted and its number saved again — is two rows that already satisfy the key and are left
 * alone. Of two or more **live** contacts on one phone with one number, the favourite is kept,
 * else the one edited last, else the newest; **every other one is soft-deleted, never removed**:
 * `status` becomes `'deleted'` with `updated_at` pinned, so nothing a player made is gone, the
 * migration is not mistaken for the player deleting it, and an operator can find each by the
 * ids this logs.
 *
 * The other two columns MICA-335 declares — `mica_contacts.default_number` and
 * `mica_devices.setup_pending` — are plain additions, left to the additive pass that follows
 * this in `micaschema apply`.
 *
 * **Safe to run twice**: the column and the key are each asked for first, and a database that
 * has the key has no duplicates left to settle. A table this server never imported is skipped.
 * A live server can save a duplicate between the settling and the key; the key then refuses,
 * this stops unrecorded, and the next `micaschema apply` settles it again.
 */
export const migration: Migration = {
  id: '0010_contact_numbers_unique_per_device',
  description:
    'mica_contacts gains phone_key and device_phone_unique — one live contact per number on a ' +
    'phone — after soft-deleting all but one of any live duplicates',
  up: async () => {
    if (!(await hasTable(TABLE))) return;
    if (!(await hasColumn(TABLE, 'device_id'))) {
      throw new Error(
        `${TABLE} has no device_id column, so 0002 and 0008 have not run against it. Nothing ` +
          'was changed; this migration keys on the device.'
      );
    }
    if (!(await hasColumn(TABLE, COLUMN))) {
      await Database.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${PHONE_KEY_DDL}`, []);
    }
    if (await hasIndex(TABLE, KEY)) return;

    const beaten = ((await Database.query<{ id: number | string }[]>(BEATEN, [])) ?? []).map(
      (row) => Number(row.id)
    );
    for (let i = 0; i < beaten.length; i += CHUNK) {
      const ids = beaten.slice(i, i + CHUNK);
      await Database.query(
        `UPDATE \`${TABLE}\` SET \`status\` = 'deleted', \`updated_at\` = \`updated_at\`
          WHERE \`status\` = 'active' AND \`id\` IN (${ids.map(() => '?').join(', ')})`,
        ids
      );
    }
    if (beaten.length > 0) {
      const shown = beaten.slice(0, LOGGED_IDS).join(', ');
      const more = beaten.length > LOGGED_IDS ? ` and ${beaten.length - LOGGED_IDS} more` : '';
      console.log(
        `[mica] ${TABLE}: ${beaten.length} live contact(s) shared a phone and a number with ` +
          `another; each is kept with status 'deleted' and updated_at unchanged, and the ` +
          `favourite, else the last edited, else the newest stays live. Ids: ${shown}${more}.`
      );
    }

    await Database.query(
      `ALTER TABLE \`${TABLE}\` ADD UNIQUE KEY \`${KEY}\` (\`device_id\`, \`${COLUMN}\`)`,
      []
    );
  }
};
