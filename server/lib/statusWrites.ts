// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { migrations as migrationsOnDisk } from '../migrations';
import { NO_REASON, reasonOf } from './sqlErrors';

/**
 * Whether the database has caught up with this version of micaOS, for every write that moves a
 * row's status on its own schedule: a sweep, a prune, a purge, retention, and a version written
 * beside an edit.
 *
 * **Why.** Code ships before `micaschema apply` runs. Until it does, a status the code writes may
 * not be in the live ENUM yet — `expired` before 0015 — and MariaDB does one of two things with
 * it: under `STRICT_TRANS_TABLES` it refuses the write, which a swallowing `.catch` hides; under
 * `sql_mode=''` it writes `''` with warning 1265, and the row's status is gone for good. Found by
 * replaying 0013–0016 on a copy of a live database: `pruneStale` ran at import and blanked the
 * status of every old notification.
 *
 * **One check, failing closed.** A write may run only while no migration on disk is missing from
 * the ledger, and every status it writes is in its table's live ENUM — a table or a `status`
 * column that is not there yet counts as missing. Anything that cannot be read is no. Each job
 * that is held says so once, loudly, naming the command that releases it. `micaschema apply`
 * clears the answer (`resetStatusWrites`), and a held answer is asked again a minute later, so a
 * server that another one applied for catches up without a restart.
 *
 * **Its own module, importing nothing that reaches a repository** (`lib/migrations.ts` reaches
 * `schemaSql.ts`, which reaches `Repository.ts`, which writes versions through this): the
 * migrations barrel imports only `Database`.
 */

/** The migrations ledger, `SCHEMA_MIGRATIONS_TABLE` in `schemaSql.ts`; a test holds the two. */
export const LEDGER_TABLE = 'mica_schema_migrations';

/**
 * How long an answer that holds a job stands before it is read again. One that holds nothing is
 * never re-read: it can only be made wrong by a newer micaOS, which restarts the resource.
 */
const RECHECK_MS = 60_000;

interface Currency {
  /** Migration ids on disk the ledger does not record. */
  pending: string[];
  /** Each `mica_` table's `status` ENUM values; a table with no such column is absent. */
  statuses: Map<string, string[]>;
  /** When this was read. */
  at: number;
}

let read: Promise<Currency | null> | null = null;
let readAt = 0;

/** Per job: said once, so a sweep every minute is one line, not one a minute. */
const told = new Set<string>();

const enumValues = (type: string): string[] => {
  const match = /^enum\((.*)\)$/i.exec(type.trim());
  if (!match) return [];
  return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

/** Two reads: the ledger, and every `mica_` table's `status` column. Null when either fails. */
const readCurrency = async (): Promise<Currency | null> => {
  try {
    const ledger = await Database.query<{ id: unknown }[]>(
      `SELECT \`id\` FROM \`${LEDGER_TABLE}\``,
      []
    );
    const columns = await Database.query<{ t: unknown; type: unknown }[]>(
      "SELECT TABLE_NAME AS `t`, COLUMN_TYPE AS `type` FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND column_name = 'status' AND table_name LIKE 'mica|_%' ESCAPE '|'",
      []
    );
    if (!Array.isArray(ledger) || !Array.isArray(columns)) return null;
    const applied = new Set(ledger.map((row) => String(row.id)));
    return {
      pending: migrationsOnDisk.map((m) => m.id).filter((id) => !applied.has(id)),
      statuses: new Map(columns.map((row) => [String(row.t), enumValues(String(row.type))])),
      at: Date.now()
    };
  } catch (error) {
    console.error(
      `[mica] could not tell whether the database is current (${reasonOf(error, NO_REASON)}); ` +
        'every sweep, prune and purge is held until it can.'
    );
    return null;
  }
};

/** What is behind for these writes, as words; empty when nothing is. */
const behind = (
  currency: Currency | null,
  writes: Readonly<Record<string, readonly string[]>>
): string[] => {
  if (currency === null) return ['the database could not be read'];
  const out: string[] = [];
  if (currency.pending.length > 0) out.push(`pending migrations: ${currency.pending.join(', ')}`);
  for (const [table, wanted] of Object.entries(writes)) {
    const have = currency.statuses.get(table);
    if (!have) {
      out.push(`${table} has no status column yet`);
      continue;
    }
    const missing = wanted.filter((status) => !have.includes(status));
    if (missing.length > 0)
      out.push(`${table}.status lacks ${missing.map((s) => `'${s}'`).join(', ')}`);
  }
  return out;
};

/**
 * Whether `job` may write `writes` now: by table, every status it may set. False — and said once
 * for this job — while the database is behind the code. Never throws.
 */
export const statusWritesMayRun = async (
  job: string,
  writes: Readonly<Record<string, readonly string[]>>
): Promise<boolean> => {
  if (override !== null) return override;
  const fresh = (): Promise<Currency | null> => {
    readAt = Date.now();
    read = readCurrency();
    return read;
  };
  let problems = behind(await (read ?? fresh()), writes);
  /**
   * Judged per job, then read again a minute on (MICA-430 re-review): an answer with no pending
   * migration can still lack a table only the additive pass creates (`mica_versions`), and
   * another server's `micaschema apply` creates it without resetting this one.
   */
  if (problems.length > 0 && Date.now() - readAt > RECHECK_MS) {
    problems = behind(await fresh(), writes);
  }
  if (problems.length === 0) return true;
  if (!told.has(job)) {
    told.add(job);
    console.error(
      `[mica] ${job} is held: the database is behind this version of micaOS (${problems.join('; ')}). ` +
        "Run 'micaschema apply' from the server console, after taking a backup."
    );
  }
  return false;
};

/** After `micaschema apply`: read again, and say again whatever is still held. */
export const resetStatusWrites = (): void => {
  read = null;
  readAt = 0;
  told.clear();
};

/**
 * Tests only. A unit suite's `Database` stand-in answers no schema, which would hold every write
 * it exercises; `vitest` assumes current unless a suite asks for the real check (`null`). The
 * MariaDB harnesses and a live server never take this path.
 */
let override: boolean | null = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.VITEST
  ? true
  : null;
export const __setStatusWritesForTests = (value: boolean | null): void => {
  override = value;
  resetStatusWrites();
};
