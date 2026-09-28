// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { declaredServices } from './defineService';
import { OWNER_TABLE, TABLE_COLLATION } from './schemaSql';

/**
 * MICA-157. `mica.sql` declares every table `COLLATE = utf8mb4_unicode_ci` (see
 * `schemaSql.ts`'s `TABLE_COLLATION`), and 22 of its 29 tables carry a foreign key onto
 * `players(citizenid)` — a table the framework owns, not micaOS. A foreign key requires both
 * sides to share a collation. MariaDB 11.4+ changed its default `utf8mb4` collation to
 * `utf8mb4_uca1400_ai_ci`, so a `players` table created without an explicit collation on a
 * modern MariaDB mismatches micaOS's explicit one, and the raw SQL import fails partway
 * through — some tables created, then a hard stop — with MySQL `errno: 150 "Foreign key
 * constraint is incorrectly formed"`, an error that names neither collation nor `players`.
 *
 * This cannot fix that: the failing import happens outside this resource entirely, run by
 * hand against a database this code has not connected to yet (README documents the
 * requirement for that reason). What it *can* do is fail loud, before its own DDL, the next
 * time an operator is in a position to ask this resource anything at all — `micaschema
 * apply`'s own additive pass adds `ADD KEY` statements that carry the same foreign-key
 * collation requirement, and would otherwise hit the identical opaque errno 150 with no
 * indication of why.
 */

const currentSchema = async (): Promise<string | null> =>
  (await Database.scalar<string | null>('SELECT DATABASE()', [])) ?? null;

/**
 * The framework-owned column micaOS compares its own `citizenid` against, and what the
 * comparison is: a foreign key, or a column-to-column join. The two fail differently on a
 * collation mismatch — errno 150 at DDL time versus errno 1267 at query time — so the message
 * names the one that applies. Only `players` is checked today (`OWNER_COLUMNS`).
 */
export type OwnerConstraint = 'foreign-key' | 'join';

interface OwnerColumn {
  table: string;
  column: string;
  constraint: OwnerConstraint;
}

/**
 * MICA-200, then MICA-299. Probed in this order, first hit wins — and today there is one entry.
 *
 * qb owns `players(citizenid)`, and every micaOS foreign key points at it, so a mismatch there
 * is errno 150 on the DDL `micaschema apply` is about to run: a refusal is the right answer.
 *
 * ESX has `users(identifier)`, which `mica.esx.sql` puts no foreign key on. MICA-200 added it
 * here anyway, on the grounds that a column-to-column **join** onto it would be errno 1267 on
 * the stock ESX setup (es_extended leaves the collation to the server default, from MariaDB
 * 11.4 `utf8mb4_uca1400_ai_ci`). The orphan sweep turned out to be that join, and MICA-299
 * fixed it in the statement (`orphanSweep.ownerComparison`, which compares in the owner's own
 * collation); every other read of `users` compares against a bound parameter, which is
 * collation-coercible (`FrameworkBridge`, MICA-197). So nothing a mismatch on `users` breaks
 * remains, and refusing on it would refuse `micaschema apply` — the only way an ESX server
 * gets its versioned migrations — on every stock ESX install on a current MariaDB, over
 * nothing, with a remedy (ALTER a table es_extended owns) that is not micaOS's to ask for.
 *
 * `OwnerConstraint` keeps its `'join'` member so that a future owner column which genuinely
 * is joined can be added back here with a message that names the right errno — and the new
 * join should reach for `ownerComparison`'s approach first.
 */
const OWNER_COLUMNS: readonly OwnerColumn[] = [
  { table: OWNER_TABLE, column: 'citizenid', constraint: 'foreign-key' }
];

const columnCollation = async (
  schema: string,
  { table, column }: OwnerColumn
): Promise<string | null> =>
  await Database.scalar<string | null>(
    `SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [schema, table, column]
  );

/**
 * The first framework-owned column present in this schema, with its live collation — or
 * `null` when neither exists, which is not a mismatch, it is the absence of anything to
 * compare (a standalone install, or a database no framework has populated yet).
 */
const ownerCollation = async (
  schema: string
): Promise<{ owner: OwnerColumn; collation: string } | null> => {
  for (const owner of OWNER_COLUMNS) {
    const collation = await columnCollation(schema, owner);
    if (collation) return { owner, collation };
  }
  return null;
};

/**
 * The collation an already-created micaOS table's own `citizenid` column actually carries,
 * read live rather than assumed. Preferred over `TABLE_COLLATION` when available, as a
 * defensive check against a hand-edited live table rather than only the generated file; falls
 * back to `TABLE_COLLATION` (the caller's job) when no micaOS table has been created yet at
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
  /** What breaks on the mismatch, so the message can say which errno the operator would
   * otherwise meet. */
  constraint: OwnerConstraint;
}

/**
 * Compare the framework's owner column (`players.citizenid`; see `OWNER_COLUMNS` for why not
 * ESX's `users.identifier`) against what micaOS's own tables use, before any DDL runs. Returns
 * `null` when there is nothing to check (no such column, or the current schema could not be
 * determined) or when the collations agree; a `CollationMismatch` otherwise, naming both sides
 * so the caller can fail loud instead of letting MySQL's own errno surface unexplained.
 */
export const checkOwnerCollation = async (): Promise<CollationMismatch | null> => {
  const schema = await currentSchema();
  if (!schema) return null;

  const found = await ownerCollation(schema);
  if (!found) return null;

  const expected = (await liveGphoneCollation(schema)) ?? TABLE_COLLATION;
  if (found.collation === expected) return null;

  return {
    ownerTable: found.owner.table,
    ownerColumn: found.owner.column,
    ownerCollation: found.collation,
    expectedCollation: expected,
    constraint: found.owner.constraint
  };
};

/** Why the mismatch matters, in the terms the operator would otherwise meet it: the errno and
 * the moment it fires. */
const constraintConsequence: Record<OwnerConstraint, string> = {
  'foreign-key':
    'A foreign key requires both sides of the relationship to share a collation, and this ' +
    'mismatch is what turns into MySQL errno 150 ("Foreign key constraint is incorrectly ' +
    'formed") with no further detail.',
  join:
    'A column-to-column join requires both sides to share a collation (a comparison against ' +
    'a bound parameter does not), and this mismatch is what turns into MySQL errno 1267 ' +
    '("Illegal mix of collations") in whichever query first joins the two tables.'
};

/** The message `runApply` logs and refuses to proceed past. Exported so tests hold the two
 * sides of the same string rather than duplicating it. */
export const collationMismatchMessage = (mismatch: CollationMismatch): string =>
  `[micaschema] refusing to apply: \`${mismatch.ownerTable}\`.\`${mismatch.ownerColumn}\` is ` +
  `collated ${mismatch.ownerCollation}, but micaOS's own tables use ${mismatch.expectedCollation}. ` +
  `${constraintConsequence[mismatch.constraint]} Recreate or ALTER \`${mismatch.ownerTable}\` so ` +
  `\`${mismatch.ownerColumn}\` is collated ${mismatch.expectedCollation}, then run ` +
  '`micaschema apply` again.';
