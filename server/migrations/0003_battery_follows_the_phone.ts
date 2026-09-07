// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_battery';
const PHONES = 'mica_phones';

const hasColumn = async (table: string, column: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(count) > 0;
};

const hasIndex = async (table: string, index: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(count) > 0;
};

/** Each citizen's lowest-id phone — the same map `0002` keyed everything else on. */
const CITIZEN_PHONE = `(
  SELECT p.\`citizenid\`, p.\`phone_id\`
    FROM \`${PHONES}\` p
    JOIN (SELECT \`citizenid\`, MIN(\`id\`) AS \`id\` FROM \`${PHONES}\` GROUP BY \`citizenid\`) f
      ON f.\`id\` = p.\`id\`
)`;

/**
 * MICA-283: the battery charge belongs to the phone. Two phones hold two charges, and a
 * battery bank charges the one in hand. The deferred half of MICA-257, and the last table
 * MICA-219 moves.
 *
 * The same four moves `0002_phone_data_follows_the_phone` made for the other device tables,
 * on this one: the column and its key; an unclaimed phone for any citizen who has a charge
 * and no phone — the common case, since `0002` minted only for citizens with rows in the
 * tables it moved, and nearly every character has a battery row and nothing else; every row
 * onto its citizen's phone; and the per-citizen unique key replaced by a per-phone one, added
 * before the old one is dropped so a failure part-way leaves the old invariant standing.
 *
 * Safe to run twice: every DDL step asks `information_schema` first, the mint skips anyone
 * with a phone, and the backfill touches only rows still holding NULL.
 */
export const migration: Migration = {
  id: '0003_battery_follows_the_phone',
  description:
    `gives ${TABLE} a phone_id, mints an unclaimed phone for every citizen with a charge and ` +
    `no phone, puts every row on its owner's phone, and swaps citizenid_unique for ` +
    `phone_id_unique — two phones hold two charges`,
  up: async () => {
    if (!(await hasColumn(TABLE, 'phone_id'))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD COLUMN \`phone_id\` varchar(32) DEFAULT NULL`,
        []
      );
    }
    if (!(await hasIndex(TABLE, 'phone_id'))) {
      await Database.query(`ALTER TABLE \`${TABLE}\` ADD KEY \`phone_id\` (\`phone_id\`)`, []);
    }

    const unphoned = await Database.query<{ citizenid: string }[]>(
      `SELECT DISTINCT b.\`citizenid\` FROM \`${TABLE}\` b
        WHERE b.\`citizenid\` IS NOT NULL AND b.\`citizenid\` <> ''
          AND NOT EXISTS (SELECT 1 FROM \`${PHONES}\` p WHERE p.\`citizenid\` = b.\`citizenid\`)`,
      []
    );
    for (const { citizenid } of unphoned ?? []) {
      await Database.query(
        `INSERT INTO \`${PHONES}\` (\`citizenid\`, \`phone_id\`, \`claimed\`) VALUES (?, ?, 0)`,
        [citizenid, randomBytes(16).toString('hex')]
      );
    }
    console.log(
      `[mica] ${TABLE}: minted ${unphoned?.length ?? 0} unclaimed phone(s) for citizens who had ` +
        `a charge but no phone. Each is adopted by the first phone item its owner uses.`
    );

    await Database.query(
      `UPDATE \`${TABLE}\` t
         JOIN ${CITIZEN_PHONE} ph ON ph.\`citizenid\` = t.\`citizenid\`
          SET t.\`phone_id\` = ph.\`phone_id\`, t.\`updated_at\` = t.\`updated_at\`
        WHERE t.\`phone_id\` IS NULL`,
      []
    );

    if (!(await hasIndex(TABLE, 'phone_id_unique'))) {
      await Database.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE KEY \`phone_id_unique\` (\`phone_id\`)`,
        []
      );
    }
    if (await hasIndex(TABLE, 'citizenid_unique')) {
      await Database.query(`ALTER TABLE \`${TABLE}\` DROP KEY \`citizenid_unique\``, []);
    }
  }
};
