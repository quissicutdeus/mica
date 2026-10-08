// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OwnerTable } from '../FrameworkBridge';
import { identifier, type Clause } from './sql';
import type { OwnerMatch } from './owner';

/**
 * `ow.<owner column> = <micaOS column>`, in the owner column's collation. MICA-299.
 *
 * micaOS pins every column to `TABLE_COLLATION`; es_extended creates `users.identifier` with
 * none, so from MariaDB 11.4 it is `utf8mb4_uca1400_ai_ci`. A column-to-column comparison
 * across two implicit collations has no coercible side, and every sweep statement failed with
 * errno 1267 "Illegal mix of collations" — deleting nothing, rows or hosted files, on exactly
 * the framework where this sweep was the only cleanup there was.
 *
 * Fixed in the statement rather than detected and refused, because refusing would leave that
 * whole class of server — stock ESX on a current MariaDB — with no cleanup at all, and the
 * only remedy would be to ALTER a table es_extended owns. And fixed on **micaOS's** side,
 * never the owner's: an explicit `COLLATE` outranks an implicit one, so the comparison runs in
 * the owner's collation and the owner column is left bare, which is what keeps its primary key
 * usable. Collating `ow.<column>` instead would make the statement legal and turn every
 * correlated probe into a full scan of the framework's character table (see
 * `FrameworkBridge`'s note on MICA-197). `CONVERT … USING` first, because `COLLATE` alone is
 * an error when the two character sets differ — an older `utf8mb3` `users`, say.
 *
 * The same holds on qb since MICA-300: with the foreign key onto `players` gone, nothing
 * forces `players.citizenid` to share micaOS's collation any more either.
 *
 * Without `match` the comparison is left bare — an owner column with no collation at all.
 */
const ownerComparison = (owner: OwnerTable, micaColumn: string, match: OwnerMatch | null) => {
  const ownerColumn = identifier(owner.column, 'the owner column');
  if (!match) return `ow.${ownerColumn} = ${micaColumn}`;
  const charset = identifier(match.charset, "the owner column's character set");
  const collation = identifier(match.collation, "the owner column's collation");
  return `ow.${ownerColumn} = CONVERT(${micaColumn} USING ${charset}) COLLATE ${collation}`;
};

/**
 * Whose rows a planned delete is for: SQL true for a row, given its qualifier and its owner
 * column. The one thing the three deletes differ in.
 *
 * A player's own delete and the character-deleted purge are *told* a citizenid. The sweep
 * *infers* its owners — every row whose owner is no longer in the owner table — and so it is
 * the one that must prove it can see that table first (`resolveOwner`). Everything after the
 * scope — the plan, the holds, the cascade guard — is the same code for all three, so a guard
 * added for one cannot be missing from another.
 */
export interface OwnerScope {
  owns: (row: string, column: string) => Clause;
  /** Console prefix. */
  label: string;
  /** What a failure is logged as being for. */
  purpose: string;
}

export const citizenScope = (citizenid: string, purpose: string): OwnerScope => ({
  owns: (row, column) => ({
    sql: `${row}.\`${identifier(column, 'an owner column')}\` = ?`,
    params: [citizenid]
  }),
  label: 'mica',
  purpose
});

/**
 * The sweep's scope: a row whose owner the owner table does not hold, compared in the owner
 * column's collation (`ownerComparison`).
 *
 * `NOT EXISTS` rather than `NOT IN`, because `NOT IN` against a subquery containing a single
 * NULL is unknown for every row and would silently delete nothing at all — a sweep that
 * quietly does nothing reads exactly like one that had nothing to do.
 *
 * And **never** by reading the owner list into memory and building `WHERE citizenid NOT IN
 * (…)`. A partial read — a `LIMIT`, a paged read that failed halfway, a driver truncation —
 * makes everything outside the fetched page an orphan. `NOT EXISTS` against the live table
 * has no such failure mode. This is the "optimisation" to refuse.
 *
 * It is in the `DELETE` as well as the plan, so a row whose owner reappeared between the two
 * is not deleted. The owner table is aliased `ow` because the plan's own statements already
 * use `p` for a parent row.
 */
export const orphanScope = (
  owner: OwnerTable,
  match: OwnerMatch | null,
  label = 'mica'
): OwnerScope => {
  const ownerTable = identifier(owner.table, 'the owner table');
  return {
    owns: (row, column) => ({
      sql:
        `NOT EXISTS (SELECT 1 FROM ${ownerTable} ow WHERE ` +
        `${ownerComparison(owner, `${row}.\`${identifier(column, 'an owner column')}\``, match)})`,
      params: []
    }),
    label,
    purpose: 'in the orphan sweep'
  };
};
