// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { declaredServices, type ColumnDef, type ColumnType } from './defineService';
import { SCHEMA_MIGRATIONS_TABLE } from './schemaSql';

/**
 * Age-based retention for player content (MICA-167): messages, DMs and media.
 *
 * `Notifications.pruneStale` is the pattern this grew from, and it is kept for what it got
 * right — a convar in days, read per run so `set` from the console needs no restart. What it
 * does not do, and this does:
 *
 * - **Bounded statements.** Each pass selects at most `RETENTION_BATCH` ids and deletes exactly
 *   those, then yields before the next — the shape `lib/orphanSweep.ts` uses for the same
 *   reason: one unbounded `DELETE` holds row locks on every match, and every write into that
 *   table waits behind it.
 * - **A schedule.** At resource start and every `RETENTION_INTERVAL_MS`.
 * - **Holds.** A row is never removed while something still needs it:
 *   - an open report on it (`mica_reports`, `status = 'active'`, `resolution = 'pending'`);
 *   - a live reference to it — a row in another service's declared child table (a photo
 *     attached to a message, blab or listing) whose parent row still exists. So media expires
 *     only when it is old **and** nothing live shows it; a year-old photo attached to this
 *     morning's message stays exactly as long as the message does;
 *   - whatever the owning service adds (`RetentionPolicy.holds`): an open report on a message
 *     holds its whole conversation, one on a DM or an account holds that thread or that
 *     account's DMs.
 *
 *   Every hold is asked twice per batch — in the select, and again in the delete — so a report
 *   filed in between still wins. A hold that has to read the table being deleted from (the
 *   conversation and thread holds) reads it through a `DISTINCT` derived table, which both
 *   engines materialise, so the delete never trips MySQL's error 1093.
 * - **The children.** A pruned row's own child tables (a message's attachments and reactions)
 *   carry `ON DELETE CASCADE` in `mica.sql`, but `SchemaMigrator` never adds a foreign key, so
 *   an older install has none; each batch removes the ones whose parent is now gone.
 * - **The first-run grace.** Nothing is deleted until a window has been announced for 24 hours
 *   (`graceRemainingMs`), and a shorter window is a new announcement.
 * - **The index.** A table without its `created_at` key is not pruned at all
 *   (`preflight`): every batch would be a table scan.
 *
 * All time is the database's: cutoffs are `NOW() - INTERVAL ? DAY`, grace ages are
 * `TIMESTAMPDIFF` against `NOW()`, so this process's clock and time zone move nothing.
 *
 * Nothing here writes `mica_reports`. The only table it writes besides the pruned ones is the
 * migrations ledger, for the grace markers.
 */

/** Rows per statement against the pruned table. Never more than this in one `DELETE`. */
export const RETENTION_BATCH = 500;

/**
 * Batches per table per run: 100,000 rows. A larger backlog drains over the next runs rather
 * than in one sitting that holds the database's attention for minutes.
 */
export const RETENTION_MAX_BATCHES = 200;

/** Every six hours. Retention is measured in days, so this is precise enough and cheap. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long a window is announced before anything under it is deleted. */
export const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A breath between batches. The deletes are async to oxmysql already, so the script thread is
 * never blocked; this lets queued player writes into the same table run between two batches.
 */
const YIELD_MS = 50;

const REPORTS_TABLE = 'mica_reports';

/** `r` is the alias every hold gives `mica_reports`. */
export const OPEN_REPORT = "r.`status` = 'active' AND r.`resolution` = 'pending'";

/**
 * Read a retention convar's raw string into days, `0` meaning off.
 *
 * - unset or empty → `fallback`, the default the owning service chose and justified;
 * - `0` or `off` → off, the explicit "keep forever" an owner may genuinely need;
 * - a positive whole number → that many days;
 * - anything else → `fallback`, **and says so**.
 *
 * Deliberately `GetConvar`, not `GetConvarInt`: the latter answers `0` for a value it cannot
 * parse, so a typo would read as "off". Here a typo lands on the default and is logged.
 */
export const parseRetentionDays = (raw: unknown, fallback: number, convar: string): number => {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '') return fallback;
  if (text === '0' || text === 'off') return 0;
  if (/^\d+$/.test(text)) {
    const days = Number.parseInt(text, 10);
    if (Number.isSafeInteger(days) && days > 0) return days;
  }
  console.warn(
    `[mica] ${convar} is '${String(raw)}', which is not a number of days; using ${fallback}. ` +
      "Set it to a whole number of days, or to 0 (or 'off') to keep this content forever."
  );
  return fallback;
};

/** A table whose rows point at a pruned row and go with it. */
export interface RetentionDependent {
  table: string;
  /** The column holding the pruned row's `id`. */
  column: string;
  /** For a table shared by several parents: only rows whose `column` equals `value`. */
  scope?: { column: string; value: string };
}

/**
 * An extra hold a service declares: SQL that is true while the candidate row must be kept.
 *
 * `sql` is given the row's qualifier — `t` in the select, the backquoted table name in the
 * delete — and must reference the row's columns only through it. `params` bind in order and
 * must not depend on the qualifier. An open report is spelled with alias `r` and
 * `OPEN_REPORT`. A hold that reads the pruned table itself must do so through a `DISTINCT`
 * derived table, never directly, or the delete fails on MySQL (error 1093).
 */
export interface RetentionHold {
  sql: (row: string) => string;
  params: readonly unknown[];
}

export interface RetentionPolicy {
  /** Console prefix, and the name `runRetention` reports under. */
  label: string;
  /** The service's resolved table. Must have `id` and an indexed `created_at`. */
  table: string;
  /** The window in days, `0` for off, read on every run at the convar's own call site. */
  days: () => number;
  /** The convar `days` reads, named in the warnings so an owner knows what to set. */
  convar: string;
  /** Dependents keyed by `(target_table, target_id)` rather than a declared reference. */
  dependents?: readonly RetentionDependent[];
  /** Holds only the owning service can express. See `RetentionHold`. */
  holds?: readonly RetentionHold[];
  /** What the rows point at outside the database, released once they are gone. */
  external?: RetentionExternal;
}

/**
 * Something a pruned row names outside the database — a photo on an image host (MICA-243).
 *
 * `collect` runs before each batch's delete, because afterwards the rows are gone and so is
 * the reference; it is a query like the select, and if it throws the batch is not deleted,
 * since deleting the rows would strand whatever they named. `release` runs after, with what
 * `collect` answered, and decides for itself what nothing references any more — a row the
 * delete's re-check spared still does. A failed release is logged and the prune carries on:
 * the rows are already deleted, and a host outage must not stop the next batch.
 */
export interface RetentionExternal {
  collect: (ids: readonly number[]) => Promise<readonly string[]>;
  release: (refs: readonly string[]) => Promise<void>;
}

const policies = new Map<string, RetentionPolicy>();

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** MySQL cannot bind an identifier (§2.9); only a declared, plain one reaches the SQL here. */
const identifier = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`contentRetention: refusing to build SQL from ${what} '${String(value)}'.`);
  }
  return value;
};

/** Register a table for the scheduled prune. Called by the owning service, once. */
export const registerRetention = (policy: RetentionPolicy): void => {
  identifier(policy.table, 'a retention table');
  if (policies.has(policy.table)) {
    throw new Error(`registerRetention: '${policy.table}' is already registered.`);
  }
  policies.set(policy.table, policy);
};

/** Every registered policy, in registration order. */
export const retentionPolicies = (): RetentionPolicy[] => [...policies.values()];

const asColumnDef = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * The pruned table's **own** children: child tables its service declares with a column
 * referencing it — a message's attachments and reactions. They go with the row.
 */
export const declaredDependents = (table: string): RetentionDependent[] => {
  const out: RetentionDependent[] = [];
  for (const service of declaredServices) {
    if (service.table !== table) continue;
    for (const child of service.childTables) {
      for (const [name, spec] of Object.entries(child.columns)) {
        const ref = asColumnDef(spec).references;
        if (ref?.table === table && ref.column === 'id') {
          out.push({ table: child.name, column: name });
        }
      }
    }
  }
  return out;
};

/** A row in another service's child table that points at the pruned table. */
export interface LiveReference {
  child: string;
  /** Column in `child` holding the pruned row's id. */
  column: string;
  /** The declaring service's table, and the child column that points at it. */
  parentTable: string;
  parentColumn: string;
}

/**
 * Every **other** service's child table that references `table` and names its own parent —
 * `mica_messages_attachments.photo_id` for media. Found from the declarations, because some
 * of those services are Store add-ons `server/lib` may not name (`sdk/coreBoundary.test.ts`).
 */
export const liveReferences = (table: string): LiveReference[] => {
  const out: LiveReference[] = [];
  for (const service of declaredServices) {
    if (service.table === table) continue;
    for (const child of service.childTables) {
      const cols = Object.entries(child.columns).map(([name, spec]) => ({
        name,
        ref: asColumnDef(spec).references
      }));
      const parent = cols.find((c) => c.ref?.table === service.table && c.ref.column === 'id');
      if (!parent) continue;
      for (const col of cols) {
        if (col.ref?.table === table && col.ref.column === 'id') {
          out.push({
            child: identifier(child.name, 'a child table'),
            column: identifier(col.name, 'a child column'),
            parentTable: identifier(service.table, 'a parent table'),
            parentColumn: identifier(parent.name, 'a child column')
          });
        }
      }
    }
  }
  return out;
};

/**
 * Every hold on `policy.table`, for the row qualifier `row`, with its parameters in order.
 * See the file header for what each one is.
 */
export const holdClause = (
  policy: RetentionPolicy,
  row: string
): { sql: string; params: unknown[] } => {
  const parts = [
    `NOT EXISTS (SELECT 1 FROM \`${REPORTS_TABLE}\` r WHERE r.\`target_table\` = ? ` +
      `AND r.\`target_id\` = ${row}.\`id\` AND ${OPEN_REPORT})`
  ];
  const params: unknown[] = [policy.table];
  for (const ref of liveReferences(policy.table)) {
    parts.push(
      `NOT EXISTS (SELECT 1 FROM \`${ref.child}\` a JOIN \`${ref.parentTable}\` p ` +
        `ON p.\`id\` = a.\`${ref.parentColumn}\` WHERE a.\`${ref.column}\` = ${row}.\`id\`)`
    );
  }
  for (const hold of policy.holds ?? []) {
    parts.push(`NOT (${hold.sql(row)})`);
    params.push(...hold.params);
  }
  return { sql: parts.join(' AND '), params };
};

const affectedRows = (result: unknown): number => {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    const value = Number((result as { affectedRows?: unknown }).affectedRows);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
};

const firstNumber = (rows: unknown, column: string): number => {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const value = Number((rows[0] as Record<string, unknown>)[column]);
  return Number.isFinite(value) ? value : 0;
};

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, YIELD_MS));

/** Say a thing once per process — a condition that holds every six hours is not news each time. */
const said = new Set<string>();
const sayOnce = (key: string, line: string): void => {
  if (said.has(key)) return;
  said.add(key);
  console.warn(line);
};

let ledgerSeen = false;

/** Whether the migrations ledger exists; cached once it does, since it is never dropped. */
const ledgerExists = async (): Promise<boolean> => {
  if (ledgerSeen) return true;
  ledgerSeen =
    firstNumber(
      await Database.query(
        'SELECT COUNT(*) AS `n` FROM information_schema.TABLES ' +
          'WHERE `table_schema` = DATABASE() AND `table_name` = ?',
        [SCHEMA_MIGRATIONS_TABLE]
      ),
      'n'
    ) > 0;
  return ledgerSeen;
};

/**
 * Whether a table can be pruned at all on this database, and says why once when it cannot.
 *
 * Both halves are what `micaschema apply` brings: the ledger the grace markers live in, and
 * the `created_at` key the batches walk. Without the key every batch is a scan of the whole
 * table — the stall this module exists to avoid — so the table waits rather than degrades.
 */
const preflight = async (policy: RetentionPolicy): Promise<boolean> => {
  if (!(await ledgerExists())) {
    sayOnce(
      'ledger',
      `[mica] retention: ${SCHEMA_MIGRATIONS_TABLE} does not exist yet — run micaschema apply; ` +
        'nothing is pruned until then.'
    );
    return false;
  }
  const indexed = firstNumber(
    await Database.query(
      'SELECT COUNT(*) AS `n` FROM information_schema.STATISTICS ' +
        'WHERE `table_schema` = DATABASE() AND `table_name` = ? ' +
        "AND `column_name` = 'created_at' AND `seq_in_index` = 1",
      [policy.table]
    ),
    'n'
  );
  if (indexed === 0) {
    sayOnce(
      `index:${policy.table}`,
      `[mica] retention: ${policy.table} is not indexed yet — run micaschema apply; ` +
        'nothing is pruned until then.'
    );
    return false;
  }
  return true;
};

/**
 * The grace markers: rows in `mica_schema_migrations`, id `retention:<table>:<days>d`, whose
 * `applied_at` is when that window was announced.
 *
 * That ledger because it is the one server-owned `id → timestamp` table micaOS has, so the
 * markers cost no new table, column or `micaschema apply` of their own. The migration runner
 * only asks which on-disk migration ids are missing from it (`pendingMigrations`), so an id
 * no file carries is never read as a migration, and the `retention:` prefix cannot collide
 * with the `NNNN_name` shape migration ids have.
 */
export const retentionMarkerId = (table: string, days: number): string =>
  `retention:${table}:${days}d`;

/**
 * The `LIKE` that finds a table's markers. Deliberately unescaped: a backslash escape matches
 * nothing under `sql_mode = NO_BACKSLASH_ESCAPES`, and then the grace never saw its own marker,
 * re-announced every six hours and never pruned. The `_` in a table name is a one-character
 * wildcard here, so this can over-match; `markerDays` then keeps only this table's own ids,
 * exactly, and nothing is ever written or deleted by pattern.
 */
const markerPattern = (table: string): string => `retention:${table}:%`;

const markerDays = (id: string, table: string): number | null => {
  const match = /^retention:([A-Za-z0-9_]+):(\d+)d$/.exec(id);
  return match && match[1] === table ? Number(match[2]) : null;
};

/** This table's markers, exactly: its window in days and its age in seconds. */
const readMarkers = async (
  table: string
): Promise<{ id: string; days: number; ageSeconds: number }[]> => {
  const rows = await Database.query<{ id: string; age: number | string | null }[]>(
    `SELECT \`id\`, TIMESTAMPDIFF(SECOND, \`applied_at\`, NOW()) AS \`age\` ` +
      `FROM \`${SCHEMA_MIGRATIONS_TABLE}\` WHERE \`id\` LIKE ?`,
    [markerPattern(table)]
  );
  if (!Array.isArray(rows)) throw new Error(`could not read ${SCHEMA_MIGRATIONS_TABLE}`);
  const out: { id: string; days: number; ageSeconds: number }[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const days = markerDays(id, table);
    const ageSeconds = Number(row.age);
    if (days !== null && Number.isFinite(ageSeconds)) out.push({ id, days, ageSeconds });
  }
  return out;
};

/**
 * How old a marker for a **shorter** window may be and still cover this one: 30 days.
 *
 * A 7-day window announced a year ago says nothing about what an owner expects today, so a
 * switch from 180 to 30 must be announced again rather than inherit it. A marker for exactly
 * the current window always counts: that window was announced, and re-announcing it every
 * month would be noise.
 */
export const RETENTION_COVER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One-shot timers that run a table's first real prune when its grace ends. */
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const scheduleGraceEnd = (policy: RetentionPolicy, remainingMs: number): void => {
  if (graceTimers.has(policy.table)) return;
  graceTimers.set(
    policy.table,
    setTimeout(() => {
      graceTimers.delete(policy.table);
      void runOne(policy);
    }, remainingMs)
  );
};

/**
 * How long until `days` may be enforced on this table, in ms; `0` when it may be now.
 *
 * A marker for `d` days covers the window `d`, and any longer window while the marker is
 * under `RETENTION_COVER_MAX_AGE_MS` old — a longer window deletes a subset of what `d`
 * announced, but only a recent announcement is one an owner can be taken to remember. So:
 *
 * - a covering marker whose 24 hours are up → prune;
 * - covering markers still inside their 24 hours → wait for the earliest (a restart never
 *   moves it: the age is the database's);
 * - no covering marker — the first run, or the window got **shorter** → count what the new
 *   window would take, write its marker, warn, and wait the full grace.
 *
 * Throws if the ledger cannot be read or written; the caller deletes nothing on a throw.
 */
const graceRemainingMs = async (
  policy: RetentionPolicy,
  days: number,
  hold: { sql: string; params: unknown[] }
): Promise<number> => {
  const table = policy.table;
  let remaining: number | null = null;
  for (const marker of await readMarkers(table)) {
    const ageMs = marker.ageSeconds * 1000;
    const covers =
      marker.days === days || (marker.days < days && ageMs <= RETENTION_COVER_MAX_AGE_MS);
    if (!covers) continue;
    const left = Math.max(0, RETENTION_GRACE_MS - ageMs);
    remaining = remaining === null ? left : Math.min(remaining, left);
  }

  if (remaining === 0) return 0;
  if (remaining !== null) {
    console.log(
      `[mica] retention: ${table} is inside its announced grace; nothing is deleted before ` +
        `${new Date(Date.now() + remaining).toISOString()}.`
    );
    scheduleGraceEnd(policy, remaining);
    return remaining;
  }

  const count = firstNumber(
    await Database.query(
      `SELECT COUNT(*) AS \`n\` FROM \`${table}\` t ` +
        `WHERE t.\`created_at\` < NOW() - INTERVAL ? DAY AND ${hold.sql}`,
      [days, ...hold.params]
    ),
    'n'
  );
  await Database.query(`INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [
    retentionMarkerId(table, days)
  ]);
  console.warn(
    `[mica] retention: ${count} ${table} rows are older than ${days} days and will be deleted ` +
      `from ${new Date(Date.now() + RETENTION_GRACE_MS).toISOString()}. ` +
      `Set ${policy.convar} "0" to keep them forever.`
  );
  scheduleGraceEnd(policy, RETENTION_GRACE_MS);
  return RETENTION_GRACE_MS;
};

/**
 * Retention is off: forget every announcement for this table, so switching it back on is a
 * fresh 24 hours with a fresh count rather than a marker from before the owner changed their
 * mind. Observed on every run (start and every six hours).
 */
const forgetMarkers = async (policy: RetentionPolicy): Promise<void> => {
  const timerForTable = graceTimers.get(policy.table);
  if (timerForTable !== undefined) {
    clearTimeout(timerForTable);
    graceTimers.delete(policy.table);
  }
  if (!(await ledgerExists())) return;
  const ids = (await readMarkers(policy.table)).map((marker) => marker.id);
  if (ids.length === 0) return;
  await Database.query(
    `DELETE FROM \`${SCHEMA_MIGRATIONS_TABLE}\` WHERE \`id\` IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
};

/** Tables with a prune in flight, so a scheduled run and `micamedia prune` never overlap. */
const running = new Set<string>();

/** Whether a prune of `table` is in progress right now. */
export const isRetentionRunning = (table: string): boolean => running.has(table);

/**
 * Prune one table: rows older than its window, in batches, never a held row, never inside a
 * grace, never without its index. **A hard delete.** Returns the rows removed from the table
 * itself (children are not counted).
 *
 * `created_at` and every status: the sentence an owner agrees to is "content older than N
 * days is removed", and the holds are the only exceptions.
 */
export const pruneTable = async (policy: RetentionPolicy): Promise<number> => {
  if (running.has(policy.table)) return 0;
  running.add(policy.table);

  try {
    const days = policy.days();
    if (!(days > 0)) {
      await forgetMarkers(policy);
      return 0;
    }
    const table = identifier(policy.table, 'a retention table');
    if (!(await preflight(policy))) return 0;

    const selectHold = holdClause(policy, 't');
    const deleteHold = holdClause(policy, `\`${table}\``);
    if ((await graceRemainingMs(policy, days, selectHold)) > 0) return 0;

    const dependents = [...declaredDependents(table), ...(policy.dependents ?? [])];
    const selectSql =
      `SELECT t.\`id\` FROM \`${table}\` t ` +
      `WHERE t.\`created_at\` < NOW() - INTERVAL ? DAY AND ${selectHold.sql} ` +
      `ORDER BY t.\`created_at\`, t.\`id\` LIMIT ${RETENTION_BATCH}`;

    let removed = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const rows = await Database.query<{ id: number }[]>(selectSql, [days, ...selectHold.params]);
      const ids = (Array.isArray(rows) ? rows : [])
        .map((row) => Number(row.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .slice(0, RETENTION_BATCH);
      if (ids.length === 0) return removed;

      const marks = ids.map(() => '?').join(', ');
      const refs = policy.external ? await policy.external.collect(ids) : [];
      // Every hold and the window are asked again, so a report filed since the select wins.
      removed += affectedRows(
        await Database.query(
          `DELETE FROM \`${table}\` WHERE \`id\` IN (${marks}) ` +
            `AND \`created_at\` < NOW() - INTERVAL ? DAY ` +
            `AND ${deleteHold.sql} LIMIT ${RETENTION_BATCH}`,
          [...ids, days, ...deleteHold.params]
        )
      );

      // Children only of the parents that are actually gone — a row the re-check spared
      // keeps its attachments.
      for (const dep of dependents) {
        const depTable = identifier(dep.table, 'a dependent table');
        const depColumn = identifier(dep.column, 'a dependent column');
        const scope = dep.scope
          ? ` AND \`${identifier(dep.scope.column, 'a dependent scope column')}\` = ?`
          : '';
        await Database.query(
          `DELETE FROM \`${depTable}\` WHERE \`${depColumn}\` IN (${marks})${scope} ` +
            `AND NOT EXISTS (SELECT 1 FROM \`${table}\` p WHERE p.\`id\` = \`${depTable}\`.\`${depColumn}\`)`,
          dep.scope ? [...ids, dep.scope.value] : ids
        );
      }

      if (policy.external && refs.length > 0) {
        try {
          await policy.external.release(refs);
        } catch (error) {
          console.error(`[${policy.label}] releasing what the pruned rows named failed:`, error);
        }
      }

      if (ids.length < RETENTION_BATCH) return removed;
      await pause();
    }

    console.warn(
      `[${policy.label}] retention reached ${RETENTION_MAX_BATCHES * RETENTION_BATCH} rows in ` +
        `one run; the rest are left for the next run rather than held in one long sitting.`
    );
    return removed;
  } finally {
    running.delete(policy.table);
  }
};

const runOne = async (policy: RetentionPolicy): Promise<number> => {
  try {
    const removed = await pruneTable(policy);
    if (removed > 0) {
      console.log(
        `[${policy.label}] removed ${removed} row(s) older than ${policy.days()} day(s).`
      );
    }
    return removed;
  } catch (error) {
    console.error(`[${policy.label}] retention prune failed:`, error);
    return 0;
  }
};

/**
 * Run every registered policy, one table after another. **Never rejects**: this runs from a
 * timer and from resource start, and one table failing must not stop the others.
 */
export const runRetention = async (): Promise<Record<string, number>> => {
  const result: Record<string, number> = {};
  for (const policy of retentionPolicies()) {
    result[policy.label] = await runOne(policy);
  }
  return result;
};

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Start the schedule: one run now, then every `RETENTION_INTERVAL_MS`. Idempotent.
 *
 * Called from `onResourceStart`, never at module scope: a query on import would run inside
 * every server suite that loads a service.
 */
export const startRetentionSchedule = (): void => {
  if (timer !== undefined) return;
  // Say what resolved, once: a window a typo moved is the failure this line makes loud.
  for (const policy of retentionPolicies()) {
    const days = policy.days();
    console.log(`[${policy.label}] retention ${days > 0 ? `${days} day(s)` : 'off'}.`);
  }
  timer = setInterval(() => void runRetention(), RETENTION_INTERVAL_MS);
  void runRetention();
};

/** Tests only: forget the schedule, the timers and what has been said. */
export const resetRetentionForTests = (): void => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  running.clear();
  for (const pending of graceTimers.values()) clearTimeout(pending);
  graceTimers.clear();
  said.clear();
  ledgerSeen = false;
};

/** The resource-start hook, exported so a test can prove it is the one registered. */
export const onRetentionResourceStart = (resourceName: string): void => {
  if (resourceName !== GetCurrentResourceName()) return;
  startRetentionSchedule();
};

on('onResourceStart', onRetentionResourceStart);
