// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { AUDIT_LOG_TABLE } from './AuditLogger';
import { declaredServices, type ColumnDef, type ColumnType } from './defineService';
import { FrameworkBridge, type OwnerTable } from './FrameworkBridge';
import { OWNER_TABLE } from './schemaSql';
import { openReportHold } from './contentRetention';
import { isReportableTable } from './moderation';

/**
 * Delete the rows a character left behind, on a schema where nothing else will.
 *
 * ## Read this before changing anything below
 *
 * **A sweep that reads "I cannot see the owner table" as "everything is an orphan" deletes
 * every row on the server.** That is not a hypothetical failure mode; it is the *default*
 * one, because "no rows came back" and "the question could not be asked" are the same shape
 * to almost every query interface, and the deletion looks like a success in the log. Every
 * guard in this file exists to keep those two apart, and the rule they all serve is:
 *
 * > Never infer deletion from absence of evidence.
 *
 * Each guard below is a specific way that inference has been shown to sneak back in. If one
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

/** The column every micaOS table names its owner in. */
const OWNER_COLUMN = 'citizenid';

/**
 * How many rows one statement may name.
 *
 * An unbounded `DELETE` across 22 tables at boot holds row locks over the whole schema, and
 * every phone write on a busy server queues behind it. Deleting planned ids a chunk at a time
 * bounds one statement's lock footprint and lets the loop yield between batches.
 */
const DELETE_CHUNK = 500;

/**
 * How many passes a table that references itself gets — a stop, not a target.
 *
 * Such a table (a reply under a post) goes leaves first, one level per pass. A loop whose exit
 * condition is "the database stopped giving me rows" has no exit condition if the database
 * keeps giving them, and a boot-time task that never finishes is its own outage. Hitting this
 * is a failure for that table, said as one, never a silent keep.
 */
const MAX_CHUNKS = 200;

/** How many distinct owners are sampled to check the two sides speak the same identity. */
const IDENTITY_SAMPLE = 25;

/** A micaOS table and the column in it that names the character the rows belong to. */
export interface OwnedTable {
  table: string;
  column: string;
}

/**
 * Only ever a name this repo wrote, never anything off the wire — and checked anyway.
 *
 * MySQL cannot parameterize a table or a column name (AGENTS.md §2.9), so every identifier
 * in this file is interpolated. All of them come from `defineService` declarations and from
 * frozen literals in `FrameworkBridge`, none of which a payload can reach, so this cannot
 * fire today. It is here because the property "no caller supplies one of these" is invisible
 * at the point where the string is concatenated into a `DELETE`, and the next person to add
 * a parameter to `sweepOrphanedRows` will read that line, not this argument.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const identifier = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `orphanSweep: refusing to build SQL from ${what} '${String(value)}'. Table and column ` +
        'names are interpolated because MySQL cannot bind them, so only a plain identifier ' +
        'this repo declared may reach here.'
    );
  }
  return value;
};

/**
 * MICA-159. MICA-152 (above) resolves the owner table from the three-state framework
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

const asColumnDef = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * Every table whose rows belong to a character, derived rather than listed.
 *
 * A hand-written list is a list that goes stale the next time somebody declares a service,
 * and it goes stale silently — the new table simply never gets swept, which reads exactly
 * like a table with nothing to sweep. So the set comes from the declarations:
 *
 * - **Every declared service's primary table.** `citizenid` is one of the five columns
 *   `defineService` supplies, so every one of them has an owner.
 * - **Every child table that declares a `citizenid` column of its own** — the owner column's
 *   name, with the `citizenId` flag that sizes it. Child tables are DDL-only — no repository,
 *   no events — and five of them (`mica_messages_participants`, the reactions on a message,
 *   and the three attachment tables) carry their own owner. A derivation that walked only
 *   `declaredServices` would miss all five; `SchemaMigrator` walks both levels for the same
 *   reason. Until MICA-300 these were found by their foreign key onto `players`; that key is
 *   gone, and the column name is the same test the primary tables have always passed.
 * - **`mica_audit_logs`**, which has no declaration behind it — see `AUDIT_LOG_TABLE`.
 *
 * Six further child tables hang off micaOS's *own* tables rather than off the owner
 * (`mica_account_follows` → `mica_accounts(id)`, and friends). They are deliberately not
 * here: they carry no citizenid to key on, and their rows go with the parent by its foreign
 * key — when the plan lets the parent go (`CascadeOptions.dependents`). That is also why this
 * must issue real per-table `DELETE`s and never a `TRUNCATE` or anything under
 * `FOREIGN_KEY_CHECKS = 0` — either would orphan those six permanently, with nothing left to
 * find them by.
 *
 * Computed on call, never at module scope: `declaredServices` is filled as a side effect of
 * each `defineService`, so a value captured at import time holds only the services that
 * happened to load first.
 */
export const ownedTables = (): OwnedTable[] => {
  const out: OwnedTable[] = [];
  const seen = new Set<string>();
  const add = (table: string, column: string): void => {
    if (seen.has(table)) return;
    seen.add(table);
    out.push({ table, column });
  };

  for (const service of declaredServices) {
    add(service.table, OWNER_COLUMN);
    for (const child of service.childTables) {
      const owner = child.columns[OWNER_COLUMN];
      if (owner !== undefined && asColumnDef(owner).citizenId === true) {
        add(child.name, OWNER_COLUMN);
      }
    }
  }

  add(AUDIT_LOG_TABLE, OWNER_COLUMN);

  return out;
};

/**
 * Something an owned table's rows name outside the database — a photo on an image host
 * (MICA-243) — which must be released when the rows go, or it outlives them. MICA-292.
 *
 * The same two halves as retention's `RetentionExternal`, for the same reasons: `collect`
 * runs **before** the delete, since afterwards the rows and the reference are gone, and if it
 * throws that table is not deleted from at all — deleting the rows would strand whatever they
 * named. `release` runs after, with what `collect` answered, and decides for itself what is
 * still referenced, so collecting more than was deleted is safe and collecting less is the
 * only failure. It is caught and logged: the rows are already gone.
 *
 * `where` is SQL that is true for exactly the rows about to be deleted, qualifying the row
 * as `t`, with its parameters in order. It is built here from declared identifiers only.
 */
export interface OwnedExternal {
  collect: (
    where: { sql: string; params: readonly unknown[] },
    limit: number
  ) => Promise<readonly string[]>;
  release: (refs: readonly string[]) => Promise<void>;
}

const externals = new Map<string, OwnedExternal>();

/**
 * Register what an owned table's rows name outside the database. Called by the owning service,
 * once — `server/lib` names no service's table itself (`sdk/coreBoundary.test.ts`).
 */
export const registerOwnedExternal = (table: string, external: OwnedExternal): void => {
  identifier(table, 'an owned table');
  if (externals.has(table)) {
    throw new Error(`registerOwnedExternal: '${table}' is already registered.`);
  }
  externals.set(table, external);
};

/**
 * Retention's open-report hold (`openReportHold`, MICA-167) for a table a player can report,
 * or `null` for one they cannot. MICA-292.
 *
 * The purge and the sweep used to take every row a character owned, reported or not, and
 * once they also delete the hosted file a player under an open report could delete their
 * character and destroy the photo that was reported. Retention never could, so neither can
 * these: a reported row, what hangs off it, and whatever those name, stay until the report
 * resolves, and the next sweep takes them then. The predicate is retention's own, not a copy.
 *
 * Only reportable tables, because only those have rows a report can name — and the hold
 * reads the row's `id`, which not every owned table has.
 */
const evidenceHold = (table: string, row: string): { sql: string; params: unknown[] } | null =>
  isReportableTable(table) ? openReportHold(table, row) : null;

/**
 * The most references collected per chunk: far more than one chunk's rows can name, so a
 * collect that fills it is worth a warning rather than routine.
 */
const COLLECT_LIMIT = MAX_CHUNKS * DELETE_CHUNK;

const releaseCollected = async (
  label: string,
  table: string,
  external: OwnedExternal,
  refs: readonly string[]
): Promise<void> => {
  if (refs.length === 0) return;
  if (refs.length >= COLLECT_LIMIT) {
    console.warn(
      `[${label}] ${table}: ${COLLECT_LIMIT} or more references were collected in one pass; ` +
        'some of what the deleted rows named may not have been released.'
    );
  }
  try {
    await external.release(refs);
  } catch (error) {
    console.error(`[${label}] releasing what the deleted ${table} rows named failed:`, error);
  }
};

/** Why a sweep deleted nothing. Every one of these is a refusal, not a result. */
export type SkipReason =
  | 'unknown-framework'
  | 'owner-unreadable'
  | 'owner-empty'
  | 'identity-mismatch'
  | 'nothing-owned'
  | 'owner-override-invalid';

export interface SweepFailure {
  table: string;
  error: unknown;
}

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
const announceSkip = (
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

const resolveOwner = async (tables: readonly OwnedTable[]): Promise<OwnerVerdict> => {
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

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown })?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

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

/** SQL with its parameters in order. */
interface Clause {
  sql: string;
  params: unknown[];
}

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
interface OwnerScope {
  owns: (row: string, column: string) => Clause;
  /** Console prefix. */
  label: string;
  /** What a failure is logged as being for. */
  purpose: string;
}

const citizenScope = (citizenid: string, purpose: string): OwnerScope => ({
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

/** Let the server breathe between batches. Nothing is waiting on this. */
const yieldToServer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

export interface PurgeException {
  table: string;
  /**
   * The rows to keep, as SQL over the row qualifier `row`. Absent keeps the whole table.
   * Built by the caller from declared identifiers only; it is interpolated.
   */
  keep?: (row: string) => { sql: string; params: unknown[] };
}

/**
 * What a purge keeps beyond the report hold, and which child tables go with their parent.
 * The character-deleted purge passes no `except`; a player's own delete does (MICA-168).
 */
export interface PurgeOptions {
  except?: readonly PurgeException[];
  /** Never let a `DELETE` cascade into a row this purge would not delete itself. */
  cascade?: CascadeOptions;
  /**
   * Purge only these. Defaults to every owned table. A table left out is never deleted from,
   * so a row in it that references a purged table keeps what it references.
   */
  only?: readonly OwnedTable[];
  /** What a failure is logged as being for. Defaults to a player's own delete. */
  purpose?: string;
}

export interface CascadeOptions {
  /**
   * Tables with no owner column whose rows belong to their parent row and go with it — a tag
   * on a post, a like of it, a follow of an account. Named by the caller, since which tables
   * those are is a per-app fact. A child table that is neither owned nor named here keeps its
   * parent whenever it has a row, which is the safe answer and the reason a new one is a
   * decision (`privacy.test.ts`).
   */
  dependents: readonly string[];
}

/** A foreign key between two micaOS tables: `child.column` references `parent.parentColumn`. */
export interface CascadeEdge {
  child: string;
  column: string;
  parent: string;
  parentColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

/**
 * Every foreign key from one micaOS table to another, derived from the declarations — the same
 * walk `ownedTables` makes. `SET NULL` and `RESTRICT` are kept too: the first rewrites another
 * player's row, the second would fail the delete, and neither is something a purge should
 * reach into blind. A reference to the framework's owner table is not one of these; micaOS
 * declares none since MICA-300, and `schemaSql` refuses to emit one.
 */
export const cascadeEdges = (): CascadeEdge[] => {
  const out: CascadeEdge[] = [];
  const add = (child: string, column: string, spec: ColumnType | ColumnDef): void => {
    const ref = asColumnDef(spec).references;
    if (!ref || ref.table === OWNER_TABLE) return;
    out.push({
      child,
      column,
      parent: ref.table,
      parentColumn: ref.column,
      onDelete: ref.onDelete ?? 'CASCADE'
    });
  };
  for (const service of declaredServices) {
    for (const { name, def } of service.fields) add(service.table, name, def);
    for (const child of service.childTables) {
      for (const [name, spec] of Object.entries(child.columns)) add(child.name, name, spec);
    }
  }
  return out;
};

const withKept = (
  hold: Clause | null,
  exception: PurgeException | undefined,
  row: string
): Clause | null => {
  const keep = exception?.keep?.(row);
  if (!keep) return hold;
  const sql = `NOT (${keep.sql})`;
  return hold
    ? { sql: `${hold.sql} AND ${sql}`, params: [...hold.params, ...keep.params] }
    : { sql, params: keep.params };
};

export interface PurgeResult {
  removed: number;
  /**
   * The rows this purge left behind on purpose: what the report hold keeps, what hangs off a
   * held row, and what a cascade from it would have reached. Excepted rows are not counted,
   * nor is a table that failed.
   */
  kept: number;
  failures: SweepFailure[];
}

interface PlannedResult extends PurgeResult {
  byTable: Record<string, number>;
}

/**
 * Children before parents, among the owned tables: a table goes only once every owned table
 * that references it has gone. A cycle other than a table referencing itself cannot be
 * ordered, and is refused rather than guessed at.
 */
const childrenFirst = (
  tables: readonly OwnedTable[],
  edges: readonly CascadeEdge[]
): OwnedTable[] => {
  const pending = new Map(tables.map((owned) => [owned.table, owned]));
  const order: OwnedTable[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      ({ table }) =>
        !edges.some((e) => e.parent === table && e.child !== table && pending.has(e.child))
    );
    if (ready.length === 0) {
      throw new Error(
        `purgeOwnedRows: the foreign keys among ${[...pending.keys()].join(', ')} form a cycle, ` +
          'so no table can be deleted from first. Refusing rather than guessing.'
      );
    }
    for (const owned of ready) {
      order.push(owned);
      pending.delete(owned.table);
    }
  }
  return order;
};

/**
 * What keeps a parent row: any row still referencing it once this purge has deleted the
 * children it will delete. Children go first, so what remains is exactly what the purge is not
 * deleting — another player's, held, excepted, or kept for a child of its own — and deleting
 * the parent would take it by cascade. A self-reference reads through a `DISTINCT` derived
 * table, restricted to this purge's rows, because the `DELETE` targets that table (MySQL error
 * 1093; `RetentionHold` has the same rule).
 */
const cascadeGuard = (
  owned: OwnedTable,
  edges: readonly CascadeEdge[],
  dependents: ReadonlySet<string>,
  scope: OwnerScope,
  row: string
): Clause | null => {
  const parts: string[] = [];
  const params: unknown[] = [];
  const hasChildren = (table: string): boolean => edges.some((e) => e.parent === table);
  for (const edge of edges) {
    if (edge.parent !== owned.table) continue;
    if (dependents.has(edge.child) && !hasChildren(edge.child)) continue;
    const child = identifier(edge.child, 'a child table');
    const col = identifier(edge.column, 'a reference column');
    const parentCol = identifier(edge.parentColumn, 'a referenced column');
    if (edge.child === owned.table) {
      const bound = scope.owns('p', owned.column);
      parts.push(
        `NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT c.\`${col}\` AS \`k\` FROM \`${child}\` c ` +
          `JOIN \`${child}\` p ON p.\`${parentCol}\` = c.\`${col}\` WHERE ${bound.sql}) g ` +
          `WHERE g.\`k\` = ${row}.\`${parentCol}\`)`
      );
      params.push(...bound.params);
    } else {
      parts.push(
        `NOT EXISTS (SELECT 1 FROM \`${child}\` c WHERE c.\`${col}\` = ${row}.\`${parentCol}\`)`
      );
    }
  }
  return parts.length > 0 ? { sql: parts.join(' AND '), params } : null;
};

/**
 * Keep a row whose parent is under an open report *now* (MICA-168). The plan already keeps a
 * held parent's children, but a report filed between the plan and the `DELETE` would not: the
 * child goes first, checking only its own row's hold. So each child's statement also asks
 * whether any reportable parent it references is held, with retention's own `openReportHold`
 * over the parent. Read through a `DISTINCT` derived table bounded to this purge's rows, which
 * is also what makes a self-reference (a reply under a post) legal on MySQL (error 1093).
 */
const parentHold = (
  owned: OwnedTable,
  edges: readonly CascadeEdge[],
  scope: OwnerScope,
  row: string
): Clause | null => {
  const parts: string[] = [];
  const params: unknown[] = [];
  const child = identifier(owned.table, 'a child table');
  for (const edge of edges) {
    if (edge.child !== owned.table || !isReportableTable(edge.parent)) continue;
    const parent = identifier(edge.parent, 'a parent table');
    const col = identifier(edge.column, 'a reference column');
    const bound = scope.owns('cc', owned.column);
    const hold = openReportHold(parent, 'pp');
    parts.push(
      `NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT pp.\`id\` AS \`k\` FROM \`${parent}\` pp ` +
        `JOIN \`${child}\` cc ON cc.\`${col}\` = pp.\`id\` WHERE ${bound.sql} ` +
        `AND NOT (${hold.sql})) h WHERE h.\`k\` = ${row}.\`${col}\`)`
    );
    params.push(...bound.params, ...hold.params);
  }
  return parts.length > 0 ? { sql: parts.join(' AND '), params } : null;
};

const joined = (...clauses: (Clause | null)[]): Clause | null => {
  const present = clauses.filter((c): c is Clause => c !== null);
  if (present.length === 0) return null;
  return { sql: present.map((c) => c.sql).join(' AND '), params: present.flatMap((c) => c.params) };
};

/**
 * Test seam: runs once a purge has planned and before it deletes anything, so a suite can file
 * a report in exactly the window a real one could land in.
 */
let beforeDelete: (() => Promise<void>) | undefined;
export const __setPurgeHookForTests = (fn?: () => Promise<void>): void => {
  beforeDelete = fn;
};

const selectRows = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
  const rows = await Database.query(sql, params);
  if (!Array.isArray(rows)) throw new Error(`purgeOwnedRows: no rows came back for ${sql}`);
  return rows as T[];
};

/** Which of `ids` are still there, read back rather than inferred from a row count. */
const survivors = async (
  owned: OwnedTable,
  scope: OwnerScope,
  ids: readonly number[]
): Promise<number[]> => {
  const name = identifier(owned.table, 'a swept table');
  const left: number[] = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const bound = scope.owns('t', owned.column);
    const rows = await selectRows<{ id: unknown }>(
      `SELECT t.\`id\` AS \`id\` FROM ${name} t WHERE ${bound.sql} ` +
        `AND t.\`id\` IN (${chunk.map(() => '?').join(', ')})`,
      [...bound.params, ...chunk]
    );
    left.push(...rows.map((r) => Number(r.id)));
  }
  return left.sort((a, b) => a - b);
};

interface RowPlan {
  /** Ids this purge will delete. Only ever shrinks. */
  go: Set<number>;
  /** Ids kept as evidence: held, or hanging off a held row. Only ever grows. */
  evidence: Set<number>;
  /** The scope's rows that are not excepted, for `kept`. */
  counted: number;
}

interface Link {
  edge: CascadeEdge;
  /** Rows referencing the scope's rows in `edge.parent`; `id` null for an untracked table. */
  rows: { id: number | null; ref: number }[];
}

/**
 * The one delete behind all three callers (MICA-168, MICA-300): every row it removes is one it
 * chose, never one a cascade chose for it, and nothing it removes is evidence. `scope` says
 * whose rows these are (`OwnerScope`).
 *
 * 1. **Plan.** Each table's candidates are the scope's rows, less what the report hold and
 *    the caller's exceptions keep. A held row seeds the evidence set.
 * 2. **Links.** Every row referencing one of the scope's rows, through every foreign key but a
 *    named dependent's (`CascadeOptions.dependents`).
 * 3. **Settle**, until nothing changes. A row that stays keeps every row it references, since
 *    deleting that would cascade into it. A row hanging off evidence is evidence: the photo on
 *    a reported post, the attachment on a reported message, a reply under a reported post —
 *    retention's `liveReferences`, over the whole graph. The two rules only ever remove
 *    candidates, so this terminates.
 * 4. **Delete**, children first, by id and scope, with the hold and `cascadeGuard` still in
 *    the statement: a reply or a report that arrived after the plan keeps its row regardless.
 *    A table referencing itself goes in passes from the leaves up; running out of passes with
 *    rows left is a failure, never a silent keep.
 *
 * **A table that cannot be planned deletes nothing, and neither does anything under it.** Its
 * held rows are unknown, so the rows hanging off it might be evidence; a link that cannot be
 * read leaves both ends where they are. Each is a failure for its table, logged where it
 * happened, and every other table still goes — the character purge and the sweep always
 * worked table by table, and one missing table must not stop the rest. A plan that cannot be
 * made at all — a cycle, a key not on `id` — throws before any statement runs.
 */
const purgePlanned = async (
  scope: OwnerScope,
  candidates: readonly OwnedTable[],
  options: PurgeOptions
): Promise<PlannedResult> => {
  const except = new Map((options.except ?? []).map((entry) => [entry.table, entry]));
  const dependents = new Set(options.cascade?.dependents ?? []);
  const edges = cascadeEdges();
  for (const edge of edges) {
    if (edge.parentColumn !== 'id') {
      throw new Error(
        `purgeOwnedRows: ${edge.child}.${edge.column} references ${edge.parent}.` +
          `${edge.parentColumn}, not its id, which the cascade plan cannot follow.`
      );
    }
  }
  const tables = candidates.filter(({ table }) => {
    const exception = except.get(table);
    return !exception || exception.keep !== undefined;
  });
  const order = childrenFirst(tables, edges);
  const byTable = new Map(order.map((owned) => [owned.table, owned]));
  const exempt = (child: string): boolean =>
    dependents.has(child) && !edges.some((e) => e.parent === child);

  const failed = new Map<string, unknown>();
  const fail = (table: string, error: unknown): void => {
    if (failed.has(table)) return;
    console.error(`[${scope.label}] purging ${table} ${scope.purpose} failed:`, error);
    failed.set(table, error);
  };
  /** Tables whose held rows, or whose rows' parents, are not known. */
  const unknown = new Set<string>();

  // 1. Plan.
  const plans = new Map<string, RowPlan>();
  for (const owned of order) {
    const plan: RowPlan = { go: new Set(), evidence: new Set(), counted: 0 };
    plans.set(owned.table, plan);
    try {
      const name = identifier(owned.table, 'a swept table');
      const exception = except.get(owned.table);
      const hold = evidenceHold(name, 't');
      const go = withKept(hold, exception, 't');
      const keep = exception?.keep?.('t');
      const bound = scope.owns('t', owned.column);
      const rows = await selectRows<{ id: unknown; go: unknown; held: unknown; ex: unknown }>(
        `SELECT t.\`id\` AS \`id\`, ` +
          `${go ? `CASE WHEN ${go.sql} THEN 1 ELSE 0 END` : '1'} AS \`go\`, ` +
          `${hold ? `CASE WHEN ${hold.sql} THEN 0 ELSE 1 END` : '0'} AS \`held\`, ` +
          `${keep ? `CASE WHEN ${keep.sql} THEN 1 ELSE 0 END` : '0'} AS \`ex\` ` +
          `FROM ${name} t WHERE ${bound.sql}`,
        [...(go?.params ?? []), ...(hold?.params ?? []), ...(keep?.params ?? []), ...bound.params]
      );
      for (const r of rows) {
        const id = Number(r.id);
        if (Number(r.go) === 1) plan.go.add(id);
        if (Number(r.held) === 1) plan.evidence.add(id);
        if (Number(r.ex) !== 1) plan.counted += 1;
      }
    } catch (error) {
      fail(owned.table, error);
      unknown.add(owned.table);
    }
  }

  // 2. Links.
  const links: Link[] = [];
  const frozen = new Set<string>();
  for (const edge of edges) {
    const parent = byTable.get(edge.parent);
    if (!parent || exempt(edge.child)) continue;
    const tracked = byTable.has(edge.child);
    try {
      const child = identifier(edge.child, 'a child table');
      const col = identifier(edge.column, 'a reference column');
      const parentName = identifier(edge.parent, 'a parent table');
      const bound = scope.owns('p', parent.column);
      const rows = await selectRows<{ id?: unknown; ref: unknown }>(
        `SELECT ${tracked ? 'c.`id` AS `id`, ' : ''}c.\`${col}\` AS \`ref\` FROM \`${child}\` c ` +
          `JOIN \`${parentName}\` p ON p.\`id\` = c.\`${col}\` WHERE ${bound.sql}`,
        bound.params
      );
      links.push({
        edge,
        rows: rows.map((r) => ({ id: tracked ? Number(r.id) : null, ref: Number(r.ref) }))
      });
    } catch (error) {
      // Which parents the child keeps, and which child rows hang off evidence, are unknown.
      fail(tracked ? edge.child : edge.parent, error);
      if (tracked) unknown.add(edge.child);
      frozen.add(edge.parent);
    }
  }

  // Everything under an unknown table stays: any of it might hang off a held row.
  for (const table of unknown) frozen.add(table);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of edges) {
      if (unknown.has(edge.parent) && byTable.has(edge.child) && !unknown.has(edge.child)) {
        unknown.add(edge.child);
        frozen.add(edge.child);
        grew = true;
      }
    }
  }
  for (const table of frozen) {
    plans.get(table)?.go.clear();
    if (!failed.has(table) && unknown.has(table)) {
      fail(
        table,
        new Error('not purged: a table its rows hang off could not be planned, so any may be held')
      );
    }
  }

  // 3. Settle.
  for (let changed = true; changed;) {
    changed = false;
    for (const { edge, rows } of links) {
      const parent = plans.get(edge.parent)!;
      const child = plans.get(edge.child);
      for (const { id, ref } of rows) {
        if (id !== null && child && parent.evidence.has(ref) && !child.evidence.has(id)) {
          child.evidence.add(id);
          child.go.delete(id);
          changed = true;
        }
        const childGoes = id !== null && child !== undefined && child.go.has(id);
        if (!childGoes && parent.go.delete(ref)) changed = true;
      }
    }
  }

  // A report filed now, between the plan and the delete, is what the next change guards.
  if (beforeDelete) await beforeDelete();

  // 4. Delete.
  let removed = 0;
  let kept = 0;
  const counts: Record<string, number> = {};
  for (const owned of order) {
    const plan = plans.get(owned.table)!;
    const ids = [...plan.go].sort((a, b) => a - b);
    const external = externals.get(owned.table);
    const refs: string[] = [];
    let deleted = 0;
    try {
      if (ids.length > 0) {
        const name = identifier(owned.table, 'a swept table');
        const exception = except.get(owned.table);
        const where = (row: string, chunk: readonly number[]) =>
          joined(
            scope.owns(row, owned.column),
            { sql: `${row}.\`id\` IN (${chunk.map(() => '?').join(', ')})`, params: [...chunk] },
            withKept(evidenceHold(name, row), exception, row),
            parentHold(owned, edges, scope, row),
            cascadeGuard(owned, edges, dependents, scope, row)
          )!;
        const selfReferencing = edges.some(
          (e) => e.parent === owned.table && e.child === owned.table
        );
        let settled = false;
        // What is still to delete. A table that references itself goes in passes, and each
        // pass re-reads which of these survived, so a deep chain costs depth × what is left
        // rather than depth × every id.
        let pending = ids;
        for (let pass = 0; pass < MAX_CHUNKS && !settled; pass++) {
          let round = 0;
          for (let i = 0; i < pending.length; i += DELETE_CHUNK) {
            const chunk = pending.slice(i, i + DELETE_CHUNK);
            if (external) {
              refs.push(...(await external.collect(where('t', chunk), COLLECT_LIMIT)));
            }
            const statement = where(name, chunk);
            round += affectedRows(
              await Database.query(`DELETE FROM ${name} WHERE ${statement.sql}`, statement.params)
            );
            await yieldToServer();
          }
          deleted += round;
          settled = !selfReferencing || round === 0 || deleted >= ids.length;
          if (!settled) pending = await survivors(owned, scope, pending);
        }
        if (!settled) {
          throw new Error(
            `stopped after ${MAX_CHUNKS} passes with ${pending.length} row(s) still to ` +
              'delete; the rest are left for another run, not counted as kept.'
          );
        }
      }
    } catch (error) {
      fail(owned.table, error);
    }
    removed += deleted;
    if (deleted > 0) counts[owned.table] = deleted;
    if (!failed.has(owned.table)) kept += plan.counted - deleted;
    if (external) await releaseCollected(scope.label, owned.table, external, refs);
  }

  const failures = [...failed].map(([table, error]) => ({ table, error }));
  return { removed, kept, failures, byTable: counts };
};
