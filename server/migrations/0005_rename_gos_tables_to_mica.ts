// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * MICA-274: carry an existing database across the rename from `gos_*` to `mica_*`.
 *
 * The same shape as `0004_rename_gphone_tables_to_gos`, for the same reason and with the
 * same failure mode: the prefix moved in `defineService`, so a server that upgrades has a
 * schema full of `gos_*` tables and a resource that will only ever ask for `mica_*`. It
 * does not fail loudly — `micaschema apply`'s additive half creates the new tables empty
 * beside the old ones, and every player looks like a fresh install with their messages,
 * contacts and photos still sitting in tables nothing reads.
 *
 * **This stacks on 0004 rather than replacing it.** Rewriting 0004 to go straight from
 * `gphone_` to `mica_` would be shorter and would be wrong: 0004 has already run against
 * databases, and a migration that changes meaning after it has been applied is a migration
 * whose ledger entry no longer describes what happened. Two hops cost one extra pass over
 * `information_schema` and stay correct whether or not 0004 ran here.
 *
 * **Discovered, not listed**, for the reason 0004 gives: the table set comes from the
 * `defineService` declarations and `childTables` adds more, so a hand-written list is
 * stale within a release. This asks what is actually there.
 *
 * **One statement, not a loop.** MySQL's `RENAME TABLE` takes a list and is atomic across
 * it, so foreign keys between two tables renamed in the same breath never see a
 * half-renamed schema.
 *
 * **Skips a name already taken**, rather than aborting the rest of `micaschema apply` on
 * the error. The empty new table is the one worth losing, but this will not make that
 * choice for an operator: it leaves the pair alone and says so.
 *
 * `gos_schema_migrations` is deliberately not renamed. `runMigrations` is reading its own
 * ledger out of `mica_schema_migrations` while this runs, and moving it mid-flight would
 * pull the floor out. The new ledger starts clean and replays 0001-0005; every one of them
 * guards with `information_schema` first, so a replay is a no-op rather than a repair.
 */

interface TableRow {
  TABLE_NAME: string;
}

const OLD_PREFIX = 'gos_';
const NEW_PREFIX = 'mica_';

export const migration: Migration = {
  id: '0005_rename_gos_tables_to_mica',
  description:
    'renames every surviving gos_* table to mica_* in one atomic statement, so a ' +
    'database from before the micaOS rename keeps its rows instead of being shadowed by ' +
    'empty tables the new prefix creates beside it',
  up: async () => {
    const rows = await Database.query<TableRow[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME LIKE ?`,
      [`${OLD_PREFIX}%`]
    );

    const candidates = (rows ?? [])
      .map((row) => row.TABLE_NAME)
      .filter((name) => name !== `${OLD_PREFIX}schema_migrations`);

    if (candidates.length === 0) return;

    // Which target names are already occupied, so a collision is skipped rather than
    // aborting the run. One query rather than one per table.
    const taken = await Database.query<TableRow[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`,
      [`${NEW_PREFIX}%`]
    );
    const occupied = new Set((taken ?? []).map((row) => row.TABLE_NAME));

    const moves = candidates
      .map((from) => ({ from, to: `${NEW_PREFIX}${from.slice(OLD_PREFIX.length)}` }))
      .filter((move) => !occupied.has(move.to));

    const skipped = candidates.length - moves.length;
    if (skipped > 0) {
      console.warn(
        `[mica] 0005: left ${skipped} table(s) alone because the mica_ name already ` +
          'exists. Look at them before deleting either side; one of the pair holds the ' +
          'real rows.'
      );
    }

    if (moves.length === 0) return;

    const clauses = moves.map((move) => `\`${move.from}\` TO \`${move.to}\``).join(', ');
    await Database.query(`RENAME TABLE ${clauses}`, []);
    console.log(`[mica] 0005: renamed ${moves.length} table(s) from gos_ to mica_.`);
  }
};
