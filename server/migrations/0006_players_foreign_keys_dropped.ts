// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/** qb's character table, frozen: the name the constraints pointed at when this shipped. */
const PLAYERS = 'players';

const sqlName = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name);

/**
 * MICA-300: every micaOS table on qb carried `FOREIGN KEY (citizenid) REFERENCES
 * players(citizenid) ON DELETE CASCADE`, so the framework deleting a character deleted their
 * micaOS rows inside MariaDB, before the character-deleted purge could apply a report hold or
 * a cascade guard — a reported post and its photo went, and through micaOS's own cascades so
 * did another player's replies under it. The declarations carry no such key any more; this
 * drops it from a database created before that, after which the purge and the orphan sweep
 * are the only cleanup, as they already were on ESX.
 *
 * **Found by what they reference, not by name.** `mica.sql` named them `fk_<service>_citizenid`
 * and a few `fk_<table>_citizenid`, but a restored dump or a hand-made table may not, so the
 * constraints are read from `information_schema`: every foreign key on a `mica_` table that
 * references `players`, whatever it is called. Nothing on any other table is touched, and a
 * foreign key between two micaOS tables stays.
 *
 * A no-op where there are none — ESX, standalone, or a qb database this already ran on — and
 * safe to run twice or to resume: each `DROP` removes one constraint the next read no longer
 * finds. MariaDB leaves the index a key used in place, so the additive pass that follows finds
 * the table in its declared shape.
 */
export const migration: Migration = {
  id: '0006_players_foreign_keys_dropped',
  description:
    `drops every foreign key from a micaOS table onto ${PLAYERS}, so a character the ` +
    'framework deletes no longer takes micaOS rows with it by ON DELETE CASCADE',
  up: async () => {
    const rows = await Database.query<{ table?: unknown; name?: unknown }[]>(
      `SELECT TABLE_NAME AS \`table\`, CONSTRAINT_NAME AS \`name\`
         FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ?
          AND TABLE_NAME LIKE 'mica\\_%'
        ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
      [PLAYERS]
    );
    // An answer this cannot read is not "there are none": the constraints would stay, and
    // with them the cascade this exists to remove.
    if (!Array.isArray(rows)) {
      throw new Error('information_schema did not answer with a list of foreign keys.');
    }

    let dropped = 0;
    for (const { table, name } of rows) {
      // Names from `information_schema`, but interpolated, so anything that is not a plain
      // identifier is refused rather than quoted — and refused before anything else moves.
      if (!sqlName(table) || !sqlName(name)) {
        throw new Error(
          `refusing to drop foreign key ${String(name)} on ${String(table)}: not a plain name.`
        );
      }
    }
    for (const { table, name } of rows) {
      await Database.query(
        `ALTER TABLE \`${String(table)}\` DROP FOREIGN KEY \`${String(name)}\``,
        []
      );
      dropped += 1;
    }
    console.log(`[mica] dropped ${dropped} foreign key(s) from micaOS tables onto ${PLAYERS}.`);
  }
};
