// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * MICA-269: carry an existing database across the rename from `gphone_*` to `gos_*`.
 *
 * The rename moved the table prefix in `defineService`, so a server that upgrades has a
 * schema full of `gphone_*` tables and a resource that will only ever ask for `gos_*`.
 * Without this it does not fail loudly — `micaschema apply`'s additive half simply creates
 * the new tables empty beside the old ones, and every player looks like a fresh install
 * with their messages, contacts and photos still sitting in tables nothing reads.
 *
 * **Discovered, not listed.** The obvious way to write this is 34 `RENAME TABLE`
 * statements, and it would be wrong within a release: the set of tables is derived from
 * the `defineService` declarations, `childTables` add more, and any of it can change. So
 * this asks `information_schema` what is actually there and renames whatever it finds,
 * which stays correct for a database from any earlier version.
 *
 * **One statement, not a loop.** MySQL's `RENAME TABLE` takes a list and is atomic across
 * it, so foreign keys between two tables being renamed in the same breath never see a
 * half-renamed schema. A loop would break the first foreign key it reached.
 *
 * **Skips a name already taken.** If both `gphone_notes` and `gos_notes` exist — an
 * operator who started the server once on the new code before running this — renaming
 * onto the occupied name errors and aborts the rest of `micaschema apply`. The empty new
 * table is the one worth losing, but this migration will not make that choice on an
 * operator's behalf: it leaves the pair alone and says so, so the operator can look.
 *
 * `gphone_schema_migrations` is deliberately not renamed here. `runMigrations` is reading
 * its own ledger out of the new name while this runs; moving it mid-flight would pull the
 * floor out. The ledger is small and disposable, and the new one starts clean.
 */

interface TableRow {
  TABLE_NAME: string;
}

const OLD_PREFIX = 'gphone_';
const NEW_PREFIX = 'gos_';

export const migration: Migration = {
  id: '0004_rename_gphone_tables_to_gos',
  description:
    'renames every surviving gphone_* table to gos_* in one atomic statement, so a ' +
    'database from before the rename keeps its rows instead of being shadowed by empty ' +
    'tables the new prefix creates beside it',
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
        `[gos] 0004: left ${skipped} table(s) alone because the gos_ name already exists. ` +
          'Look at them before deleting either side; one of the pair holds the real rows.'
      );
    }

    if (moves.length === 0) return;

    const clauses = moves.map((move) => `\`${move.from}\` TO \`${move.to}\``).join(', ');
    await Database.query(`RENAME TABLE ${clauses}`, []);
    console.log(`[gos] 0004: renamed ${moves.length} table(s) from gphone_ to gos_.`);
  }
};
