// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { AUDIT_LOG_TABLE } from './AuditLogger';
import { declaredServices, type ColumnDef, type ColumnType } from './defineService';
import { FrameworkBridge, type OwnerTable } from './FrameworkBridge';
import { OWNER_TABLE } from './schemaSql';

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
 * On qb the cleanup mechanism is the schema, not this file: 22 tables carry
 * `REFERENCES players(citizenid) ON DELETE CASCADE`, so a deleted character takes its
 * messages, contacts, notes, mail, Blabs, holdings, settings, call log, notifications and
 * reports with it inside the same statement, with no resource involvement.
 *
 * ESX has `users(identifier)` and no `players`, so `gphone.esx.sql` drops that constraint —
 * it has to, or the schema will not import at all (MICA-150). **Dropping it drops the
 * cascade with it, and nothing replaced it** (MICA-152). This is the replacement, and its
 * job is to reproduce what the cascade does on qb: exactly the rows the cascade would have
 * taken, and not one row more.
 *
 * That framing settles two questions that would otherwise be judgement calls. It is why the
 * swept set is *derived* from what carries the owner foreign key rather than from what looks
 * like it holds a citizenid — `gphone_reports.target_author` is a `varchar(50)` citizenid
 * with no FK, deliberately, because evidence has to outlive the character it names. And it
 * is why this stays a **backstop on qb**: the cascade still does the work there, this finds
 * nothing, and if it ever finds something that is an install whose table predates the
 * constraint.
 */

/** The column every gPhone table names its owner in. */
const OWNER_COLUMN = 'citizenid';

/**
 * How many rows one statement may remove.
 *
 * An unbounded `DELETE … WHERE NOT EXISTS` across 22 tables at boot is a full scan of the
 * whole schema holding row locks, and every phone write on a busy server queues behind it.
 * Chunking bounds one statement's lock footprint and lets the loop yield between batches.
 */
const DELETE_CHUNK = 500;

/**
 * How many chunks one table gets per sweep — a stop, not a target.
 *
 * A loop whose exit condition is "the database stopped giving me rows" has no exit condition
 * if the database keeps giving them, and a boot-time task that never finishes is its own
 * outage. Hitting this leaves the remainder for the next restart and says so; it does not
 * escalate to something less careful.
 */
const MAX_CHUNKS = 200;

/** How many distinct owners are sampled to check the two sides speak the same identity. */
const IDENTITY_SAMPLE = 25;

/** A gPhone table and the column in it that names the character the rows belong to. */
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
export const OWNER_OVERRIDE_CONVAR = 'gphone_orphan_owner_table';

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
  } catch {
    // Could not verify the convar names a real table — never trust an unverified name to
    // decide which rows this sweep is allowed to delete.
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
 * - **Every child table that declares a column referencing the owner table.** Child tables
 *   are DDL-only — no repository, no events — and four of them
 *   (`gphone_messages_participants`, and the three attachment tables) carry their own
 *   `citizenid` with its own foreign key. A derivation that walked only `declaredServices`
 *   would miss all four; `SchemaMigrator` already walks both levels for the same reason.
 * - **`gphone_audit_logs`**, which has no declaration behind it — see `AUDIT_LOG_TABLE`.
 *
 * Six further child tables cascade off gPhone's *own* tables rather than off the owner
 * (`gphone_account_follows` → `gphone_accounts(id)`, and friends). They are deliberately not
 * here: those foreign keys survive on ESX, so deleting the parent row takes them, and they
 * carry no citizenid for this to key on in any case. That is also why this must issue real
 * per-table `DELETE`s and never a `TRUNCATE` or anything under `FOREIGN_KEY_CHECKS = 0` —
 * either would orphan those six permanently, with nothing left to find them by.
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
      for (const [name, spec] of Object.entries(child.columns)) {
        if (asColumnDef(spec).references?.table === OWNER_TABLE) add(child.name, name);
      }
    }
  }

  add(AUDIT_LOG_TABLE, OWNER_COLUMN);

  return out;
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
  /** Per-table counts, for the tables that gave up rows. */
  byTable: Record<string, number>;
  /** Set when nothing was attempted. `null` means the sweep ran. */
  skipped: SkipReason | null;
  /** Tables whose own `DELETE` failed. One failing must not stop the other twenty-one. */
  failures: SweepFailure[];
}

const skip = (reason: SkipReason): SweepResult => ({
  removed: 0,
  byTable: {},
  skipped: reason,
  failures: []
});

/**
 * Distinct owners out of gPhone's own rows, from the first table that has any.
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
          'gPhone starts before your framework, this is expected and the next restart, or ' +
          'the character-deleted hook, will do the work.'
      );
      return;
    case 'owner-empty':
    case 'owner-unreadable':
      console.warn(
        `[${label}] ${table} is empty or unreadable — the orphan sweep was skipped rather ` +
          'than treating every row as an orphan.'
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
 *    reachable, populated, *wrong* owner table: sample distinct owners out of gPhone's own
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
  | { owner: OwnerTable; skipped: null }
  | { owner: OwnerTable | null; skipped: SkipReason; detail?: string };

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
  } catch {
    return { owner, skipped: 'owner-unreadable' };
  }
  if (!Number.isFinite(population) || population <= 0) return { owner, skipped: 'owner-empty' };

  let sample: string[];
  try {
    sample = await sampleOwners(tables);
  } catch {
    return { owner, skipped: 'owner-unreadable' };
  }
  // No gPhone rows at all: there is nothing to sweep, and nothing to check an identity
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
  } catch {
    return { owner, skipped: 'owner-unreadable' };
  }
  if (!Number.isFinite(matched) || matched <= 0) return { owner, skipped: 'identity-mismatch' };

  return { owner, skipped: null };
};

const affectedRows = (result: unknown): number => {
  const rows = (result as { affectedRows?: unknown })?.affectedRows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : 0;
};

/**
 * The statement, in one place so every table and both frameworks get the same one.
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
 * On qb this is the statement MICA-71 shipped for `gphone_media`, with a `LIMIT` on the
 * end; the alias stays `p` so that remains visibly true.
 */
export const orphanDeleteSql = (owned: OwnedTable, owner: OwnerTable): string => {
  const table = identifier(owned.table, 'a swept table');
  const column = identifier(owned.column, 'an owner column');
  const ownerTable = identifier(owner.table, 'the owner table');
  const ownerColumn = identifier(owner.column, 'the owner column');

  return (
    `DELETE FROM ${table} WHERE NOT EXISTS ` +
    `(SELECT 1 FROM ${ownerTable} p WHERE p.${ownerColumn} = ${table}.${column}) ` +
    `LIMIT ${DELETE_CHUNK}`
  );
};

/** Let the server breathe between batches. Nothing is waiting on this. */
const yieldToServer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sweepOneTable = async (owned: OwnedTable, owner: OwnerTable): Promise<number> => {
  const sql = orphanDeleteSql(owned, owner);
  let removed = 0;

  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    const batch = affectedRows(await Database.query(sql));
    removed += batch;
    if (batch < DELETE_CHUNK) return removed;
    await yieldToServer();
  }

  console.warn(
    `[gphone] ${owned.table} still had orphans after ${MAX_CHUNKS * DELETE_CHUNK} rows; the ` +
      'rest are left for the next sweep rather than held in one long transaction.'
  );
  return removed;
};

export interface SweepOptions {
  /** Sweep only these. Defaults to every owned table. */
  only?: readonly OwnedTable[];
  /** Console prefix, so `gphonemedia prune` still sounds like itself. */
  label?: string;
}

/**
 * Delete every row whose owner no longer exists. **A hard delete.**
 *
 * Never rejects. Every refusal is a `skipped` reason and every per-table failure is a
 * `failures` entry, because this runs at resource start where a rejection is a stack trace
 * on a server that is otherwise fine — and because a table that does not exist on one
 * install must not stop the other twenty-one from being swept.
 *
 * Tables are swept **sequentially**. They are independent, and issuing twenty-two
 * concurrent full-table deletes at boot is the availability problem the chunking above
 * exists to avoid, arrived at from the other direction.
 */
export const sweepOrphanedRows = async (options: SweepOptions = {}): Promise<SweepResult> => {
  const label = options.label ?? 'gphone';
  const tables = options.only ?? ownedTables();
  if (tables.length === 0) return skip('nothing-owned');

  const verdict = await resolveOwner(tables);
  if (verdict.skipped !== null || !verdict.owner) {
    const reason = verdict.skipped ?? 'unknown-framework';
    announceSkip(label, reason, verdict.owner, 'detail' in verdict ? verdict.detail : undefined);
    return skip(reason);
  }
  const owner = verdict.owner;

  const result: SweepResult = { removed: 0, byTable: {}, skipped: null, failures: [] };
  for (const owned of tables) {
    try {
      const removed = await sweepOneTable(owned, owner);
      if (removed > 0) {
        result.removed += removed;
        result.byTable[owned.table] = removed;
      }
    } catch (error) {
      result.failures.push({ table: owned.table, error });
    }
  }

  return result;
};

/**
 * Remove one named character's rows from every owned table. **A hard delete.**
 *
 * No owner-table guard here, and the asymmetry is the point rather than an oversight. The
 * sweep above *infers* which rows are unowned and so must prove it can see the owners; this
 * is *told* which character is gone by a server resource that just deleted it. There is no
 * absence of evidence to misread, and requiring a readable owner table would make the
 * immediate cleanup fail on exactly the servers that need it most — the ones where the
 * character's row is already gone.
 *
 * Bounded by a citizenid, so no chunking: one character's rows are not a full-schema scan.
 */
export const purgeOwnedRows = async (
  citizenid: string
): Promise<{ removed: number; failures: SweepFailure[] }> => {
  const owner = typeof citizenid === 'string' ? citizenid.trim() : '';
  if (owner.length === 0) return { removed: 0, failures: [] };

  let removed = 0;
  const failures: SweepFailure[] = [];

  for (const { table, column } of ownedTables()) {
    const name = identifier(table, 'a swept table');
    const col = identifier(column, 'an owner column');
    try {
      removed += affectedRows(
        await Database.query(`DELETE FROM ${name} WHERE ${col} = ?`, [owner])
      );
    } catch (error) {
      failures.push({ table, error });
    }
  }

  return { removed, failures };
};
