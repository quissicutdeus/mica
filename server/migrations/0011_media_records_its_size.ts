// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_media';
const COLUMN = 'stored_bytes';

/**
 * `stored_bytes` as `Media.ts` declared it when this shipped, frozen: a migration means what it
 * ran, whatever the declaration says later.
 */
const COLUMN_DDL = '`stored_bytes` int(11) DEFAULT NULL';

/** How many ids one backfill `UPDATE` spans. */
const CHUNK = 1000;

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

/**
 * MICA-358: `mica_media` records what each row costs against its owner's quota, so the quota
 * sums a stored number instead of `LENGTH()` over every photo the player holds, on every
 * capture. The quota keeps measuring a row from its columns while `stored_bytes` is `NULL`, so
 * a row this leaves `NULL` is counted exactly as before, only more slowly.
 *
 * **Added here rather than by the additive pass**, because the backfill needs the column and
 * `micaschema apply` runs migrations first. The pass that follows adds the index,
 * `citizenid_status_stored`, over a column already filled — one index build, not one per row.
 *
 * **Only rows with no `url` are backfilled**, with `LENGTH(data) + LENGTH(thumbnail)`: for
 * those, that is the whole of what the quota charges. A row with a `url` may be a photo on the
 * owner's image host, whose charge depends on which hosts this server has ever used (MICA-293)
 * — the service's knowledge, not a migration's. Those rows are left `NULL` and measured live,
 * which is cheap for them: a hosted row's bytes are on the host, not in `data`.
 *
 * `updated_at` is pinned: `Repository.restore` reads it as the moment a row was deleted, and a
 * backfill touching it would reopen every expired restore window.
 *
 * Walked by `id` range so each statement is short and none scans the table; every photo's
 * bytes are read once, here, rather than on every capture after. **Safe to run twice**, and
 * resumable: the column is asked for first, and a row already sized is skipped.
 */
export const migration: Migration = {
  id: '0011_media_records_its_size',
  description:
    'mica_media gains stored_bytes, each inline row backfilled with its size, so the media ' +
    'quota sums a number instead of measuring every photo',
  up: async () => {
    if (!(await hasTable(TABLE))) return;
    if (!(await hasColumn(TABLE, COLUMN))) {
      await Database.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${COLUMN_DDL}`, []);
    }

    const bounds = await Database.single<{
      low: number | string | null;
      high: number | string | null;
    }>(`SELECT MIN(\`id\`) AS low, MAX(\`id\`) AS high FROM \`${TABLE}\``, []);
    const low = Number(bounds?.low ?? NaN);
    const high = Number(bounds?.high ?? NaN);
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return;

    for (let from = low; from <= high; from += CHUNK) {
      await Database.query(
        `UPDATE \`${TABLE}\`
            SET \`${COLUMN}\` = IFNULL(LENGTH(\`data\`), 0) + IFNULL(LENGTH(\`thumbnail\`), 0),
                \`updated_at\` = \`updated_at\`
          WHERE \`id\` BETWEEN ? AND ?
            AND \`${COLUMN}\` IS NULL
            AND (\`url\` IS NULL OR \`url\` = '')`,
        [from, Math.min(from + CHUNK - 1, high)]
      );
    }
  }
};
