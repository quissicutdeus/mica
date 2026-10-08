// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { FrameworkBridge, type OwnerTable } from '../FrameworkBridge';
import { SAFE_IDENTIFIER, identifier } from './sql';
import type { OwnedTable } from './tables';

/** How many distinct owners are sampled to check the two sides speak the same identity. */
const IDENTITY_SAMPLE = 25;

/**
 * MICA-159. MICA-152 (`lib/orphanSweep.ts`) resolves the owner table from the three-state framework
 * verdict, which is the real fix for the boot-ordering hazard. This convar is a convenience
 * layered on top of it for the non-standard setup that verdict cannot cover at all — a fork,
 * a custom identity resource, a framework migration in progress — where an operator can just
 * say which table and column own a citizenid, as `table.column`.
 *
 * **Default empty means "use the framework verdict"**, not "skip the sweep" — an operator who
 * never touches this convar gets exactly MICA-152's behavior, unchanged.
 */
export const OWNER_OVERRIDE_CONVAR = 'mica_orphan_owner_table';

export interface OwnerOverride {
  /** The resolved override, when the convar named a real table and column. `null` covers
   * both "the convar is empty" and "the convar is set but unusable" — `invalid` is what
   * tells those two apart, and a caller must never conflate them. */
  owner: OwnerTable | null;
  /**
   * A non-empty convar value that did not resolve to a real, existing table and column.
   *
   * `GetConvar` hands back a free-form string with no validation of its own — the same fact
   * `client/services/Camera.ts`'s `cameraQuality` documents for `GetConvarInt` ("a convar is
   * a free-form string, so `GetConvarInt` answers 0 for anything it cannot parse"). That
   * function's answer is to clamp a bad value to the nearest usable one, because the worst
   * case is a slightly wrong JPEG quality. This convar names which rows the sweep is allowed
   * to delete, so a bad value is never silently substituted for anything — the caller must
   * fail closed and skip the sweep entirely, never fall through to the framework verdict.
   */
  invalid: boolean;
  raw: string;
}

/**
 * Read and verify the owner-table override, against `information_schema` rather than
 * trusted as typed. A well-formed `table.column` that does not name a real column in a real
 * table in this schema is exactly as untrustworthy as a malformed one — both are `invalid`.
 */
export const resolveOwnerOverride = async (): Promise<OwnerOverride> => {
  const raw = GetConvar(OWNER_OVERRIDE_CONVAR, '').trim();
  if (raw.length === 0) return { owner: null, invalid: false, raw: '' };

  const dot = raw.indexOf('.');
  const table = dot === -1 ? '' : raw.slice(0, dot);
  const column = dot === -1 ? '' : raw.slice(dot + 1);
  if (!SAFE_IDENTIFIER.test(table) || !SAFE_IDENTIFIER.test(column)) {
    return { owner: null, invalid: true, raw };
  }

  try {
    const schema = await Database.scalar<string | null>('SELECT DATABASE()', []);
    if (!schema) return { owner: null, invalid: true, raw };

    const found = await Database.scalar<number | null>(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [schema, table, column]
    );
    if (!found) return { owner: null, invalid: true, raw };
  } catch (error) {
    // Could not verify the convar names a real table — never trust an unverified name to
    // decide which rows this sweep is allowed to delete. The refusal is announced by the
    // caller; why it could not be verified is only known here (MICA-299).
    console.error(`[mica] could not verify ${OWNER_OVERRIDE_CONVAR} '${raw}':`, error);
    return { owner: null, invalid: true, raw };
  }

  return { owner: { table, column }, invalid: false, raw };
};

/** Why a sweep deleted nothing. Every one of these is a refusal, not a result. */
export type SkipReason =
  | 'unknown-framework'
  | 'owner-unreadable'
  | 'owner-empty'
  | 'identity-mismatch'
  | 'nothing-owned'
  | 'owner-override-invalid';

/**
 * Distinct owners out of micaOS's own rows, from the first table that has any.
 *
 * A non-array answer is treated as no answer and throws, rather than being read as an empty
 * sample: "the driver gave me something I do not understand" must not become "this server
 * has no rows", which is the same absence-of-evidence mistake one level down.
 */
const sampleOwners = async (tables: readonly OwnedTable[]): Promise<string[]> => {
  for (const { table, column } of tables) {
    const name = identifier(table, 'a swept table');
    const col = identifier(column, 'an owner column');
    const rows = await Database.query<unknown>(
      `SELECT DISTINCT ${col} AS owner FROM ${name} WHERE ${col} IS NOT NULL LIMIT ${IDENTITY_SAMPLE}`
    );
    if (!Array.isArray(rows)) {
      throw new Error(`orphanSweep: unrecognised result sampling owners from ${name}.`);
    }
    const owners = rows
      .map((row) => (row as { owner?: unknown })?.owner)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (owners.length > 0) return owners;
  }
  return [];
};

/**
 * Say why nothing happened, every time it does not happen.
 *
 * A sweep that silently declines is indistinguishable from a sweep that found nothing, and
 * an operator debugging a database that will not shrink has no way to tell them apart. The
 * `owner-empty` and `owner-unreadable` wording is the sentence MICA-71 shipped, with the
 * table name resolved rather than assumed, so an ESX server is told about `users`.
 */
export const announceSkip = (
  label: string,
  reason: SkipReason,
  owner: OwnerTable | null,
  detail?: string
): void => {
  const table = owner?.table ?? 'the owner table';

  switch (reason) {
    case 'unknown-framework':
      console.warn(
        `[${label}] no qb core and no es_extended answered yet, so which table owns these ` +
          'rows is not known — the orphan sweep was skipped rather than guessing. If ' +
          'micaOS starts before your framework, this is expected and the next restart, or ' +
          'the character-deleted hook, will do the work.'
      );
      return;
    case 'owner-empty':
    case 'owner-unreadable':
      console.warn(
        `[${label}] ${table} is empty or unreadable — the orphan sweep was skipped rather ` +
          'than treating every row as an orphan.' +
          (detail ? ` ${detail}` : '')
      );
      return;
    case 'identity-mismatch':
      console.warn(
        `[${label}] none of the sampled characters exist in ${table} — the orphan sweep was ` +
          'skipped rather than deleting every row on the server. Every row being an orphan ' +
          'is not a thing that happens; a wrong owner table, a framework that has not ' +
          'finished starting, or a truncated identifier all look exactly like this.'
      );
      return;
    case 'owner-override-invalid':
      console.error(
        `[${label}] ${OWNER_OVERRIDE_CONVAR} names '${detail ?? '?'}', which is not \`table.column\` ` +
          'naming a real table and column in this database — the orphan sweep was skipped ' +
          'rather than trusting an unverified value to decide which rows it may delete. ' +
          `Clear ${OWNER_OVERRIDE_CONVAR} to use the detected framework's own owner table ` +
          'instead, or correct it.'
      );
      return;
    default:
      return;
  }
};

/**
 * The owner table, confirmed usable — or the reason it is not.
 *
 * **Resolved once per sweep and passed down.** Re-deriving it per table would give
 * twenty-two chances for one answer to disagree with the other twenty-one, and the one that
 * disagrees is the one that deletes. The verdict is also never cached across a sweep: boot
 * ordering is exactly the thing that changes between one restart and the next.
 *
 * Four refusals, each catching something the others do not:
 *
 * 1. **`unknown-framework`.** Which table owns these rows is a question about the
 *    *framework*, not about which table happens to exist — a box with a leftover `players`
 *    from an old qb install *and* a live `es_extended` answers "both" to a probe and the
 *    wrong one is fatal. `FrameworkBridge.ownerTable()` returns null until it knows.
 * 2. **`owner-unreadable`.** The query threw: no such table, no privilege, oxmysql not up
 *    yet. This is the one that keeps a pure ESX server safe *today*, and note it is the
 *    `catch` doing it rather than the empty-table guard, which is the sort of thing worth
 *    knowing before rearranging them.
 * 3. **`owner-empty`.** A real answer of zero. A server with no characters has no orphans
 *    by definition, so there is nothing this could correctly delete either way.
 * 4. **`identity-mismatch`.** The belt-and-braces one, and the only guard that catches a
 *    reachable, populated, *wrong* owner table: sample distinct owners out of micaOS's own
 *    rows and require at least one of them to exist on the other side. "Every single row on
 *    this server is an orphan" is never a true answer on a live database — it is the
 *    signature of a wrong owner table, a half-started framework, or an identifier that was
 *    silently truncated on the way in (MICA-158, where an ESX multicharacter identifier
 *    overflows `citizenid varchar(50)`).
 *
 *    The bar is **one match, not a fraction**. One match proves the two sides speak the same
 *    identity vocabulary, which is the entire thing this is trying to establish; a fraction
 *    would additionally encode a guess about how much character churn is normal, and being
 *    wrong about that refuses honest sweeps. A server whose sampled rows genuinely all
 *    belong to deleted characters is refused, and that is the trade taken on purpose:
 *    leaving orphans costs disk, and the other way costs the database.
 */
type OwnerVerdict =
  | { owner: OwnerTable; match: OwnerMatch | null; skipped: null }
  | { owner: OwnerTable | null; skipped: SkipReason; detail?: string };

/**
 * The owner column's character set and collation, read live, so the sweep compares in the
 * owner's terms rather than assuming the two sides agree. MICA-299.
 *
 * `null` for an owner column that has no collation at all — a numeric id — where there is
 * nothing to reconcile and the comparison is left as it is.
 */
export interface OwnerMatch {
  charset: string;
  collation: string;
}

/** Why a caught error is worth a line: the message, never the whole driver object. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Read the owner column's collation from `information_schema`, or throw.
 *
 * Every way this can come back unusable throws rather than answering `null`, because `null`
 * means "no collation to reconcile" and an unreadable answer must not become that: a sweep
 * that then compared without `COLLATE` would be back to MICA-299's errno 1267 on every table.
 * A name that is not a plain identifier throws too — it is interpolated after `COLLATE`,
 * where MySQL cannot bind it.
 */
const readOwnerMatch = async (owner: OwnerTable): Promise<OwnerMatch | null> => {
  const row = await Database.single<{ collation?: unknown; charset?: unknown }>(
    `SELECT COLLATION_NAME AS collation, CHARACTER_SET_NAME AS charset
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [owner.table, owner.column]
  );
  if (!row) {
    throw new Error(
      `information_schema has no ${owner.table}.${owner.column} in the current database.`
    );
  }
  if (row.collation == null && row.charset == null) return null;
  return {
    charset: identifier(row.charset, "the owner column's character set"),
    collation: identifier(row.collation, "the owner column's collation")
  };
};

export const resolveOwner = async (tables: readonly OwnedTable[]): Promise<OwnerVerdict> => {
  // MICA-159, checked before the framework verdict: an invalid override must never fall
  // through to it, so this has to be the first thing decided, not a fallback tried after.
  const override = await resolveOwnerOverride();
  if (override.invalid) {
    return { owner: null, skipped: 'owner-override-invalid', detail: override.raw };
  }

  const owner = override.owner ?? FrameworkBridge.ownerTable();
  if (!owner) return { owner: null, skipped: 'unknown-framework' };

  const ownerTable = identifier(owner.table, 'the owner table');
  const ownerColumn = identifier(owner.column, 'the owner column');

  let population: number;
  try {
    const row = await Database.single<{ total: number | string | null }>(
      `SELECT COUNT(*) AS total FROM ${ownerTable}`
    );
    population = Number(row?.total ?? 0);
  } catch (error) {
    return { owner, skipped: 'owner-unreadable', detail: describeError(error) };
  }
  if (!Number.isFinite(population) || population <= 0) return { owner, skipped: 'owner-empty' };

  // MICA-299. Which collation to compare in, before anything is compared. Unreadable is a
  // refusal like any other unreadable answer here, never a guess at "the same as ours".
  let match: OwnerMatch | null;
  try {
    match = await readOwnerMatch(owner);
  } catch (error) {
    return {
      owner,
      skipped: 'owner-unreadable',
      detail: `Its collation could not be read: ${describeError(error)}`
    };
  }

  let sample: string[];
  try {
    sample = await sampleOwners(tables);
  } catch (error) {
    return { owner, skipped: 'owner-unreadable', detail: describeError(error) };
  }
  // No micaOS rows at all: there is nothing to sweep, and nothing to check an identity
  // against either. Refusing rather than proceeding costs nothing — a sweep of an empty
  // table set removes zero rows by construction — and keeps "we verified" honest.
  if (sample.length === 0) return { owner, skipped: 'nothing-owned' };

  let matched: number;
  try {
    const row = await Database.single<{ matched: number | string | null }>(
      `SELECT COUNT(*) AS matched FROM ${ownerTable} ` +
        `WHERE ${ownerColumn} IN (${sample.map(() => '?').join(', ')})`,
      [...sample]
    );
    matched = Number(row?.matched ?? 0);
  } catch (error) {
    return { owner, skipped: 'owner-unreadable', detail: describeError(error) };
  }
  if (!Number.isFinite(matched) || matched <= 0) return { owner, skipped: 'identity-mismatch' };

  return { owner, match, skipped: null };
};
