// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { declaredServices } from './defineService';
import { OWNER_TABLE, TABLE_COLLATION } from './schemaSql';

/**
 * MICA-157. `gphone.sql` declares every table `COLLATE = utf8mb4_unicode_ci` (see
 * `schemaSql.ts`'s `TABLE_COLLATION`), and 22 of its 29 tables carry a foreign key onto
 * `players(citizenid)` — a table the framework owns, not gPhone. A foreign key requires both
 * sides to share a collation. MariaDB 11.4+ changed its default `utf8mb4` collation to
 * `utf8mb4_uca1400_ai_ci`, so a `players` table created without an explicit collation on a
 * modern MariaDB mismatches gPhone's explicit one, and the raw SQL import fails partway
 * through — some tables created, then a hard stop — with MySQL `errno: 150 "Foreign key
 * constraint is incorrectly formed"`, an error that names neither collation nor `players`.
 *
 * This cannot fix that: the failing import happens outside this resource entirely, run by
 * hand against a database this code has not connected to yet (README documents the
 * requirement for that reason). What it *can* do is fail loud, before its own DDL, the next
 * time an operator is in a position to ask this resource anything at all — `gphoneschema
 * apply`'s own additive pass adds `ADD KEY` statements that carry the same foreign-key
 * collation requirement, and would otherwise hit the identical opaque errno 150 with no
 * indication of why.
 */

const currentSchema = async (): Promise<string | null> =>
  (await Database.scalar<string | null>('SELECT DATABASE()', [])) ?? null;

/**
 * The live collation of `players.citizenid`, or `null` when that column does not exist in
 * this schema at all — which is not a mismatch, it is the absence of the constraint. ESX has
 * no `players` table (`schemaSql.ts`'s `OWNER_TABLE` docs), and `gphone.esx.sql` carries no
 * foreign key onto one, so there is nothing to check on that install path.
 */
const ownerCollation = async (schema: string): Promise<string | null> =>
  await Database.scalar<string | null>(
    `SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'citizenid'`,
    [schema, OWNER_TABLE]
  );

/**
 * The collation an already-created gPhone table's own `citizenid` column actually carries,
 * read live rather than assumed. Preferred over `TABLE_COLLATION` when available, as a
 * defensive check against a hand-edited live table rather than only the generated file; falls
 * back to `TABLE_COLLATION` (the caller's job) when no gPhone table has been created yet at
 * all, which a fully-failed fresh import leaves as the only case.
 */
const liveGphoneCollation = async (schema: string): Promise<string | null> => {
  const tables = declaredServices.map((service) => service.table);
  if (tables.length === 0) return null;

  const placeholders = tables.map(() => '?').join(', ');
  return await Database.scalar<string | null>(
    `SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders}) AND COLUMN_NAME = 'citizenid'
     LIMIT 1`,
    [schema, ...tables]
  );
};

export interface CollationMismatch {
  ownerTable: string;
  ownerColumn: string;
  ownerCollation: string;
  expectedCollation: string;
}

/**
 * Compare `players.citizenid`'s live collation against what gPhone's own tables use, before
 * any DDL runs. Returns `null` when there is nothing to check (no `players.citizenid` at all,
 * or the current schema could not be determined) or when the collations agree; a
 * `CollationMismatch` otherwise, naming both sides so the caller can fail loud instead of
 * letting MySQL's own errno 150 surface unexplained.
 */
export const checkOwnerCollation = async (): Promise<CollationMismatch | null> => {
  const schema = await currentSchema();
  if (!schema) return null;

  const owner = await ownerCollation(schema);
  if (!owner) return null;

  const expected = (await liveGphoneCollation(schema)) ?? TABLE_COLLATION;
  if (owner === expected) return null;

  return {
    ownerTable: OWNER_TABLE,
    ownerColumn: 'citizenid',
    ownerCollation: owner,
    expectedCollation: expected
  };
};

/** The message `runApply` logs and refuses to proceed past. Exported so tests hold the two
 * sides of the same string rather than duplicating it. */
export const collationMismatchMessage = (mismatch: CollationMismatch): string =>
  `[gphoneschema] refusing to apply: \`${mismatch.ownerTable}\`.\`${mismatch.ownerColumn}\` is ` +
  `collated ${mismatch.ownerCollation}, but gPhone's own tables use ${mismatch.expectedCollation}. ` +
  'A foreign key requires both sides of the relationship to share a collation, and this ' +
  'mismatch is what turns into MySQL errno 150 ("Foreign key constraint is incorrectly ' +
  `formed") with no further detail. Recreate or ALTER \`${mismatch.ownerTable}\` so ` +
  `\`${mismatch.ownerColumn}\` is collated ${mismatch.expectedCollation}, then run ` +
  '`gphoneschema apply` again.';
