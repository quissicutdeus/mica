// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ownedTables, type OwnedTable } from './sweep/tables';
import { announceSkip, resolveOwner, type SkipReason } from './sweep/owner';
import { citizenScope, orphanScope } from './sweep/scope';
import {
  purgePlanned,
  type PurgeException,
  type PurgeOptions,
  type PurgeResult,
  type SweepFailure
} from './sweep/purge';
import { traceOf } from './sqlErrors';
import { eraseStrandedDependents } from './sweep/dependents';

export { ownedTables, type OwnedTable } from './sweep/tables';
export { OWNER_OVERRIDE_CONVAR, type SkipReason } from './sweep/owner';
export { orphanScope } from './sweep/scope';
export { registerDependentRows } from './sweep/dependents';
export {
  __setPurgeHookForTests,
  registerSharedRows,
  type PurgeException,
  type PurgeOptions,
  type PurgeResult,
  type SweepFailure
} from './sweep/purge';

/**
 * Erase the rows a character left behind, on a schema where nothing else will. Nothing is
 * deleted since MICA-428: the rows move to `erased` and stay, for staff and for evidence.
 *
 * ## Read this before changing anything below, or in `lib/sweep/`
 *
 * **A sweep that reads "I cannot see the owner table" as "everything is an orphan" erases
 * every row on the server** — kept, but hidden from every player, with what each row's status
 * was overwritten. That is not a hypothetical failure mode; it is the *default*
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
 * public erases; the guards it rests on are in `lib/sweep/`, split along the same lines this
 * file was always read in:
 *
 * - `sql.ts` — `identifier`, the check every interpolated name goes through.
 * - `tables.ts` — which tables are owned (`ownedTables`), and which can be erased
 *   (`hasStatus`).
 * - `owner.ts` — the owner table, confirmed usable or refused (`resolveOwner`), the
 *   `mica_orphan_owner_table` override, and the line said when a sweep is skipped.
 * - `scope.ts` — whose rows an erase is for: a named citizen, or every orphan.
 * - `purge.ts` — `purgePlanned`, the one write behind all three callers, and the shared rows
 *   it leaves live while others are in them (`registerSharedRows`).
 */

export interface SweepResult {
  /** Rows erased across every table swept. */
  erased: number;
  /**
   * Orphaned rows left as they were on purpose: under a takedown, or kept by an exception.
   */
  kept: number;
  /** Per-table counts, for the tables that had rows erased. */
  byTable: Record<string, number>;
  /** Set when nothing was attempted. `null` means the sweep ran. */
  skipped: SkipReason | null;
  /**
   * Tables that could not be erased from; `*` when the sweep stopped as a whole. One failing
   * must not stop the others.
   */
  failures: SweepFailure[];
}

const skip = (reason: SkipReason): SweepResult => ({
  erased: 0,
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
   * What the sweep keeps though its owner is gone (`PurgeException`). It has to be the same
   * list the character-deleted purge keeps: with no foreign key onto the owner any more, the
   * sweep is what would otherwise take those rows as orphans at the next start (MICA-300).
   */
  except?: readonly PurgeException[];
}

/**
 * Erase every row whose owner no longer exists (MICA-428: a status change, never a delete).
 *
 * The same write as the character-deleted purge and a player's own delete (`purgePlanned`),
 * for every orphaned owner at once. A row under a takedown stays `moderated`, and a reopen
 * restores `erased`. Another player's row that references an orphan's — a reply under its
 * post — is not theirs and is left as it is.
 *
 * Never rejects. Every refusal is a `skipped` reason and every per-table failure is a
 * `failures` entry, because this runs at resource start where a rejection is a stack trace
 * on a server that is otherwise fine — and because a table that does not exist on one
 * install must not stop the others from being swept.
 *
 * Tables are swept **sequentially**. Issuing thirty concurrent updates at boot is the
 * availability problem the chunking exists to avoid, arrived at from the other direction.
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
    // log-identity-ok: the owner table and column, a schema name, not a player
    const done = await purgePlanned(orphanScope(owner, match, label), tables, {
      except: options.except
    });
    /**
     * And the catch-all (MICA-429 review): any erased account or profile anywhere that still has
     * a follow, block, reaction, ear, swipe or match not yet erased — one a reopen put back to
     * `erased`, one a purge stopped part-way through. A whole sweep only: one narrowed by
     * `only` is about those tables alone.
     */
    if (options.only === undefined) {
      const stranded = await eraseStrandedDependents(label);
      for (const [table, n] of Object.entries(stranded.byTable)) {
        done.erased += n;
        done.byTable[table] = (done.byTable[table] ?? 0) + n;
      }
      done.failures.push(...stranded.failures);
    }
    return { ...done, skipped: null };
  } catch (error) {
    // Only the test seam throws here; a table's own failure is caught per table.
    console.error(`[${label}] orphan sweep stopped:`, traceOf(error));
    return { erased: 0, kept: 0, byTable: {}, skipped: null, failures: [{ table: '*', error }] };
  }
};

/**
 * Erase one named character's rows (MICA-428: a status change, never a delete). Three
 * callers, one write (`purgePlanned`), each leaving a takedown's row `moderated`:
 *
 * - **The character-deleted purge** (`lib/shell.ts`, MICA-300): the framework has deleted the
 *   character, so everything they owned is erased — except the pending reports they filed,
 *   their rows in the moderation ledger, and the device rows (`CHARACTER_EXCEPT`).
 * - **A player's own delete** (MICA-168, `services/Privacy.ts`), keeping more by `except`.
 * - **The media-only purge** (`services/Media.ts`), restricted to `mica_media` by `only`.
 *
 * No owner-table guard, and the asymmetry with the sweep is the point rather than an
 * oversight. The sweep *infers* which rows are unowned and so must prove it can see the
 * owners; this is *told* which character it is for. There is no absence of evidence to
 * misread, and requiring a readable owner table would make the immediate cleanup fail on
 * exactly the servers that need it most — the ones where the character's row is already gone.
 *
 * A hosted file a row names is kept while the row is (MICA-428): nothing is released.
 */
export async function purgeOwnedRows(
  citizenid: string,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const owner = typeof citizenid === 'string' ? citizenid.trim() : '';
  if (owner.length === 0) return { erased: 0, kept: 0, failures: [] };
  const purpose = options.purpose ?? "for a player's own delete";
  // log-identity-ok: the citizenid is bound in SQL; the scope's label and purpose are logged
  const { erased, kept, failures } = await purgePlanned(
    citizenScope(owner, purpose),
    options.only ?? ownedTables(),
    options
  );
  return { erased, kept, failures };
}
