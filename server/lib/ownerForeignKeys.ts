// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { imageHost } from './mediaHost';
import { OWNER_TABLE } from './schemaSql';

/**
 * The foreign keys from micaOS tables onto qb's `players`, found live rather than trusted to the
 * migrations ledger (MICA-300).
 *
 * Every micaOS table on qb once carried `REFERENCES players(citizenid) ON DELETE CASCADE`, so the
 * framework deleting a character deleted their micaOS rows inside MariaDB, before any report
 * hold or cascade guard could apply. Migration 0006 drops them — but the ledger is not evidence
 * that it did. Re-importing the current `mica.sql` over an existing qb database seeds 0006 as
 * applied (`INSERT IGNORE`) while every `CREATE TABLE IF NOT EXISTS` leaves the old table, keys
 * and all. So this is asked of `information_schema` every time it matters:
 *
 * - `micaschema apply` drops whatever it finds, as a standing step (`dropOwnerForeignKeys`).
 * - Resource start says, loudly, when any are there (`reportOwnerForeignKeys`).
 *
 * Migration 0006 carries its own copy of the drop, frozen, as migrations do; this is the one the
 * running code keeps current.
 */

export interface OwnerForeignKey {
  table: string;
  name: string;
}

const PLAIN = /^[A-Za-z0-9_]+$/;

/**
 * Every foreign key on a `mica_` table that references `players`, whatever it is called. Throws
 * on an answer it cannot read, and on a name it would have to quote: "could not tell" must never
 * become "there are none".
 */
export const ownerForeignKeys = async (): Promise<OwnerForeignKey[]> => {
  const rows = await Database.query<{ table?: unknown; name?: unknown }[]>(
    `SELECT TABLE_NAME AS \`table\`, CONSTRAINT_NAME AS \`name\`
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ?
        AND TABLE_NAME LIKE 'mica\\_%'
      ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
    [OWNER_TABLE]
  );
  if (!Array.isArray(rows)) {
    throw new Error('information_schema did not answer with a list of foreign keys.');
  }
  return rows.map(({ table, name }) => {
    if (typeof table !== 'string' || typeof name !== 'string') {
      throw new Error('information_schema answered a foreign key without a table or a name.');
    }
    if (!PLAIN.test(table) || !PLAIN.test(name)) {
      throw new Error(`refusing foreign key ${name} on ${table}: not a plain name.`);
    }
    return { table, name };
  });
};

/**
 * Drop every foreign key onto `players` that is still there, whatever the ledger says. Answers
 * how many it dropped; a second run drops none. Throws when it cannot finish, and every name is
 * checked before the first `DROP`, so a refusal leaves nothing half done.
 */
export const dropOwnerForeignKeys = async (): Promise<number> => {
  const keys = await ownerForeignKeys();
  for (const { table, name } of keys) {
    await Database.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``, []);
  }
  return keys.length;
};

/**
 * At resource start: an error line when any key onto `players` is still there, with the count
 * and the remedy, so an owner whose ledger lies still hears about it. With an image host
 * configured, the line says what the cascade does to hosted photos too (MICA-292's warning,
 * folded in here). A check it cannot run is said as well, rather than read as "none".
 *
 * Answers the count, or `null` when it could not tell. Never throws.
 */
export const reportOwnerForeignKeys = async (): Promise<number | null> => {
  let keys: OwnerForeignKey[];
  try {
    keys = await ownerForeignKeys();
  } catch (error) {
    console.warn(
      `[mica] could not check for foreign keys onto ${OWNER_TABLE}. If any micaOS table still ` +
        'has one, a character your framework deletes takes their micaOS rows with it. ' +
        'micaschema apply drops them.',
      error
    );
    return null;
  }
  if (keys.length === 0) return 0;

  const host = imageHost();
  const tables = [...new Set(keys.map(({ table }) => table))];
  console.error(
    `[mica] ${keys.length} foreign key(s) from micaOS tables onto ${OWNER_TABLE} still cascade ` +
      `(${tables.join(', ')}). When your framework deletes a character, MariaDB deletes their ` +
      'micaOS rows with it — reported evidence included, and other players’ replies through ' +
      "micaOS's own cascades — before micaOS can keep anything." +
      (host ? ` Their hosted photos stay on ${host}, since nothing reads the URLs first.` : '') +
      ' Run micaschema apply from the server console to drop them.'
  );
  return keys.length;
};
