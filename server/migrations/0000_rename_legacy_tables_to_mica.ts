// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * MICA-274: carry an existing database onto the `mica_*` prefix, from either old name.
 *
 * **This runs first, and that is load-bearing.** Migrations apply in id order, so anything
 * numbered above this one would run while the tables are still under their old prefix --
 * finding nothing, because it looks for `mica_*`. `0001` and `0003` guard with
 * `information_schema` and would quietly no-op, then be recorded as applied having done
 * nothing; `0002` does not guard and simply errors, aborting the run. Renaming before any
 * of them touch the schema is what makes the rest of the sequence mean anything.
 *
 * The prefix moved in `defineService`, so a server that upgrades has a schema full of
 * tables under the old name and a resource that will only ever ask for `mica_*`. It does
 * not fail loudly -- `micaschema apply`'s additive half creates the new tables empty
 * beside the old ones, and every player looks like a fresh install with their messages,
 * contacts and photos still sitting in tables nothing reads.
 *
 * **Why one migration and two source prefixes.** The rename happened twice: `gphone_` to
 * `gos_` on 2026-09-03, then `gos_` to `mica_` the next day, when `gos` turned out to read
 * as a syllable rather than a prefix. `gos` never reached a release -- the newest tag then
 * was `v2026.09.01.4` -- so there is no reason to make every future install replay an
 * intermediate nobody ever ran. The pair of migrations that did it in two hops is gone.
 *
 * Collapsing them would normally be the wrong move, because a migration that changes
 * meaning after it has been applied is one whose ledger entry no longer describes what
 * happened. What makes it safe is that this handles **both** legacy prefixes rather than
 * assuming which one is there. A database that never ran anything has `gphone_*`; one that
 * ran the old two-hop pair partway has `gos_*`; one already converted has neither and this
 * is a no-op. All three are correct without this file knowing which it is looking at, so
 * nothing here depends on reading a ledger that may or may not have the old ids in it.
 *
 * **Discovered, not listed.** The set of tables comes from the `defineService`
 * declarations and `childTables` adds more, so a hand-written list of 34 names is stale
 * within a release. This asks `information_schema` what is actually there.
 *
 * **One statement per prefix, not a loop.** MySQL's `RENAME TABLE` takes a list and is
 * atomic across it, so foreign keys between two tables renamed in the same breath never
 * see a half-renamed schema. A loop would break the first foreign key it reached.
 *
 * **Skips a name already taken** rather than aborting the rest of `micaschema apply` on
 * the error. The empty new table is the one worth losing, but this will not make that
 * choice on an operator's behalf: it leaves the pair alone and says so.
 *
 * The old `*_schema_migrations` ledgers are deliberately not renamed. `runMigrations` is
 * reading its own ledger out of `mica_schema_migrations` while this runs, and moving it
 * mid-flight would pull the floor out. The new ledger starts clean and replays 0000-0003;
 * every one of them guards with `information_schema` first, so a replay is a no-op.
 */

interface TableRow {
  TABLE_NAME: string;
}

/** Oldest first, so a database that somehow has both is walked in the order it grew. */
const LEGACY_PREFIXES = ['gphone_', 'gos_'] as const;
const NEW_PREFIX = 'mica_';

const tablesWithPrefix = async (prefix: string): Promise<string[]> => {
  const rows = await Database.query<TableRow[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME LIKE ?`,
    [`${prefix}%`]
  );
  return (rows ?? [])
    .map((row) => row.TABLE_NAME)
    .filter((name) => name !== `${prefix}schema_migrations`);
};

export const migration: Migration = {
  id: '0000_rename_legacy_tables_to_mica',
  description:
    'renames every surviving gphone_* or gos_* table to mica_* in one atomic statement ' +
    'per prefix, so a database from before either rename keeps its rows instead of being ' +
    'shadowed by empty tables the new prefix creates beside it',
  up: async () => {
    for (const prefix of LEGACY_PREFIXES) {
      const candidates = await tablesWithPrefix(prefix);
      if (candidates.length === 0) continue;

      // Which target names are already occupied, so a collision is skipped rather than
      // aborting the run. One query per prefix rather than one per table.
      const taken = await Database.query<TableRow[]>(
        `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`,
        [`${NEW_PREFIX}%`]
      );
      const occupied = new Set((taken ?? []).map((row) => row.TABLE_NAME));

      const moves = candidates
        .map((from) => ({ from, to: `${NEW_PREFIX}${from.slice(prefix.length)}` }))
        .filter((move) => !occupied.has(move.to));

      const skipped = candidates.length - moves.length;
      if (skipped > 0) {
        console.warn(
          `[mica] 0000: left ${skipped} ${prefix}* table(s) alone because the ` +
            `${NEW_PREFIX} name already exists. Look at them before deleting either ` +
            'side; one of the pair holds the real rows.'
        );
      }

      if (moves.length === 0) continue;

      const clauses = moves.map((move) => `\`${move.from}\` TO \`${move.to}\``).join(', ');
      await Database.query(`RENAME TABLE ${clauses}`, []);
      console.log(`[mica] 0000: renamed ${moves.length} table(s) from ${prefix} to ${NEW_PREFIX}.`);
    }
  }
};
