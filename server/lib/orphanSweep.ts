// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ownedTables, type OwnedTable } from './sweep/tables';
import { announceSkip, resolveOwner, type SkipReason } from './sweep/owner';
import { citizenScope, orphanScope } from './sweep/scope';
import {
  purgePlanned,
  type CascadeOptions,
  type PurgeException,
  type PurgeOptions,
  type PurgeResult,
  type SweepFailure
} from './sweep/purge';

export { cascadeEdges, ownedTables, registerOwnedExternal, type OwnedTable } from './sweep/tables';
export { OWNER_OVERRIDE_CONVAR, type SkipReason } from './sweep/owner';
export { orphanScope } from './sweep/scope';
export {
  __setPurgeHookForTests,
  type CascadeOptions,
  type PurgeException,
  type PurgeOptions,
  type PurgeResult,
  type SweepFailure
} from './sweep/purge';

/**
 * Delete the rows a character left behind, on a schema where nothing else will.
 *
 * ## Read this before changing anything below, or in `lib/sweep/`
 *
 * **A sweep that reads "I cannot see the owner table" as "everything is an orphan" deletes
 * every row on the server.** That is not a hypothetical failure mode; it is the *default*
 * one, because "no rows came back" and "the question could not be asked" are the same shape
 * to almost every query interface, and the deletion looks like a success in the log. Every
 * guard here and in `lib/sweep/` exists to keep those two apart, and the rule they all serve is:
 *
 * > Never infer deletion from absence of evidence.
 *
 * Each guard is a specific way that inference has been shown to sneak back in. If one
 * of them looks redundant, it is because it is guarding a case a different one does not
 * reach — the comment on each says which. Removing one because "the other already covers
 * it" is the change this docblock exists to stop.
 *
 * ## Why this exists at all
 *
 * **This file is the only cleanup after a deleted character, on every framework** (MICA-300).
 *
 * ESX has `users(identifier)` and no `players`, so `mica.esx.sql` never carried a foreign key
 * onto the owner (MICA-150), and this sweep was written to replace the cascade it lacked
 * (MICA-152). qb did carry one — `REFERENCES players(citizenid) ON DELETE CASCADE` on every
 * table with an owner column — and that cascade was the problem MICA-300 fixed: the framework deleting a
 * `players` row took every micaOS row with it inside MariaDB, before any hold could apply.
 * A post under an open report, the photo attached to it, and — through the cascades between
 * micaOS's own tables — another player's replies under the character's posts all went with
 * it. The constraint is gone from both files, and migration 0006 drops it from existing qb
 * databases, so the character-deleted purge and this sweep decide on both frameworks, by the
 * same plan a player's own delete uses (MICA-168): the character's own unheld rows go, and
 * nothing they would take by cascade does.
 *
 * Which rows are a character's is still *derived*, and still keyed on the column called
 * `citizenid` rather than on anything that looks like one — `mica_reports.target_author` is a
 * citizenid too, deliberately never swept, because evidence has to outlive the character it
 * names.
 */

/**
 * Where the parts live. This file is the entry point every caller imports, and holds the two
 * public deletes; the guards it rests on are in `lib/sweep/`, split along the same lines this
 * file was always read in:
 *
 * - `sql.ts` — `identifier`, the check every interpolated name goes through.
 * - `tables.ts` — which tables are owned (`ownedTables`), the keys between them
 *   (`cascadeEdges`), and what their rows name outside the database (`registerOwnedExternal`).
 * - `owner.ts` — the owner table, confirmed usable or refused (`resolveOwner`), the
 *   `mica_orphan_owner_table` override, and the line said when a sweep is skipped.
 * - `scope.ts` — whose rows a delete is for: a named citizen, or every orphan.
 * - `purge.ts` — `purgePlanned`, the one delete behind all three callers.
 */

export interface SweepResult {
  /** Rows removed across every table swept. */
  removed: number;
  /**
   * Orphaned rows left on purpose: under an open report, hanging off one that is, or the
   * parent of a row that stays. The next sweep takes what is no longer held.
   */
  kept: number;
  /** Per-table counts, for the tables that gave up rows. */
  byTable: Record<string, number>;
  /** Set when nothing was attempted. `null` means the sweep ran. */
  skipped: SkipReason | null;
  /**
   * Tables that could not be planned or deleted from, or kept whole because a table their rows
   * hang off could not be planned; `*` when no plan could be made at all. One failing must not
   * stop the others.
   */
  failures: SweepFailure[];
}

const skip = (reason: SkipReason): SweepResult => ({
  removed: 0,
  kept: 0,
  byTable: {},
  skipped: reason,
  failures: []
});

export interface SweepOptions {
  /** Sweep only these. Defaults to every owned table. */
  only?: readonly OwnedTable[];
  /** Console prefix, so `micamedia prune` still sounds like itself. */
  label?: string;
  /**
   * Which child tables go with their parent (`CascadeOptions`). Absent, none do, which keeps
   * any parent a child row still references: the safe answer for a caller that has not said.
   */
  cascade?: CascadeOptions;
  /**
   * What the sweep keeps though its owner is gone (`PurgeException`). It has to be the same
   * list the character-deleted purge keeps: with no foreign key onto the owner any more, the
   * sweep is what would otherwise take those rows as orphans at the next start (MICA-300).
   */
  except?: readonly PurgeException[];
}

/**
 * Delete every row whose owner no longer exists. **A hard delete.**
 *
 * Since MICA-300 the same plan as the character-deleted purge and a player's own delete
 * (`purgePlanned`), for every orphaned owner at once: an orphan under an open report stays,
 * and so does what hangs off it and the parents of anything that stays — a live player's
 * reply keeps the dead player's post it answers. The next sweep takes what is no longer held.
 *
 * Never rejects. Every refusal is a `skipped` reason and every per-table failure is a
 * `failures` entry, because this runs at resource start where a rejection is a stack trace
 * on a server that is otherwise fine — and because a table that does not exist on one
 * install must not stop the others from being swept.
 *
 * Tables are swept **sequentially**, children first. Issuing twenty-two concurrent deletes at
 * boot is the availability problem the chunking exists to avoid, arrived at from the other
 * direction.
 */
export const sweepOrphanedRows = async (options: SweepOptions = {}): Promise<SweepResult> => {
  const label = options.label ?? 'mica';
  const tables = options.only ?? ownedTables();
  if (tables.length === 0) return skip('nothing-owned');

  const verdict = await resolveOwner(tables);
  if (verdict.skipped !== null || !verdict.owner) {
    const reason = verdict.skipped ?? 'unknown-framework';
    announceSkip(label, reason, verdict.owner, 'detail' in verdict ? verdict.detail : undefined);
    return skip(reason);
  }
  const { owner, match } = verdict;

  try {
    const done = await purgePlanned(orphanScope(owner, match, label), tables, {
      cascade: options.cascade,
      except: options.except
    });
    return { ...done, skipped: null };
  } catch (error) {
    // A plan that cannot be made at all — a cycle, a key not on `id` — before any DELETE.
    console.error(`[${label}] orphan sweep could not plan, and deleted nothing:`, error);
    return { removed: 0, kept: 0, byTable: {}, skipped: null, failures: [{ table: '*', error }] };
  }
};

/**
 * Remove one named character's rows. **A hard delete.** Three callers, one plan
 * (`purgePlanned`), each keeping what an open report holds, what hangs off that, and anything
 * whose deletion would cascade into a row that stays:
 *
 * - **The character-deleted purge** (`lib/shell.ts`, MICA-300): the framework has deleted the
 *   character, so everything they owned goes, the device rows included — except the pending
 *   reports they filed and their rows in the moderation ledger (`CHARACTER_EXCEPT`).
 * - **A player's own delete** (MICA-168, `services/Privacy.ts`), keeping more by `except`.
 * - **The media-only purge** (`services/Media.ts`), restricted to `mica_media` by `only`.
 *
 * No owner-table guard, and the asymmetry with the sweep is the point rather than an
 * oversight. The sweep *infers* which rows are unowned and so must prove it can see the
 * owners; this is *told* which character it is for. There is no absence of evidence to
 * misread, and requiring a readable owner table would make the immediate cleanup fail on
 * exactly the servers that need it most — the ones where the character's row is already gone.
 *
 * A table with a registered `OwnedExternal` has what its deleted rows name released after
 * (MICA-292) — a deleted character's hosted photos go from the host, unless another row still
 * names them.
 */
export async function purgeOwnedRows(
  citizenid: string,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const owner = typeof citizenid === 'string' ? citizenid.trim() : '';
  if (owner.length === 0) return { removed: 0, kept: 0, failures: [] };
  const purpose = options.purpose ?? "for a player's own delete";
  const { removed, kept, failures } = await purgePlanned(
    citizenScope(owner, purpose),
    options.only ?? ownedTables(),
    options
  );
  return { removed, kept, failures };
}
