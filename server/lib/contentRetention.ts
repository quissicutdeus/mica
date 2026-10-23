// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { statusWritesMayRun } from './statusWrites';
import { declaredServices, type ColumnDef, type ColumnType } from './defineService';
import { SCHEMA_MIGRATIONS_TABLE } from './schemaSql';
import { whenSchemaReady } from './schemaReady';
import { traceOf } from './sqlErrors';
import { ERASED, EXPIRED } from './statuses';

/**
 * Age-based retention for player content (MICA-167): messages, DMs and media.
 *
 * `Notifications.pruneStale` is the pattern this grew from, and it is kept for what it got
 * right — a convar in days, read per run so `set` from the console needs no restart. What it
 * does not do, and this does:
 *
 * - **Nothing is deleted** (MICA-428). An expired row moves from `active` to `expired`, kept
 *   for staff and hidden from every player, and a hosted file it names is kept with it.
 * - **Bounded statements.** Each pass selects at most `RETENTION_BATCH` ids and moves exactly
 *   those, then yields before the next: one unbounded `UPDATE` holds row locks on every match,
 *   and every write into that table waits behind it.
 * - **A schedule.** At resource start and every `RETENTION_INTERVAL_MS`.
 * - **Holds.** A row is never removed while something still needs it:
 *   - an open report on it (`mica_reports`, `status = 'active'`, `resolution = 'pending'`);
 *   - a takedown standing on it (`status = 'moderated'`, MICA-426): the row is the evidence the
 *     ledger and the actioned report point at, and what a reopen puts back;
 *   - a live reference to it — a row in another service's declared child table (a photo
 *     attached to a message, blab or listing) whose parent row is still shown: not `deleted`,
 *     `expired` or `erased` (MICA-428 keeps every parent, so existing is no longer the test). So
 *     media expires only when it is old **and** nothing live shows it; a year-old photo attached
 *     to this morning's message stays exactly as long as the message does;
 *   - whatever the owning service adds (`RetentionPolicy.holds`): an open report on a message
 *     holds its whole conversation, one on a DM or an account holds that thread or that
 *     account's DMs.
 *
 *   Every hold is asked twice per batch — in the select, and again in the update — so a report
 *   filed in between still wins. A hold that has to read the table being updated (the
 *   conversation and thread holds) reads it through a `DISTINCT` derived table, which both
 *   engines materialise, so the update never trips MySQL's error 1093.
 * - **The children stay.** A pruned row's own child rows (a message's attachments and
 *   reactions) are left as they are; nothing shows them once their parent is hidden.
 * - **The first-run grace.** Nothing is hidden until a window has been announced for 24 hours
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

/** Rows per statement against the pruned table. Never more than this in one `UPDATE`. */
export const RETENTION_BATCH = 500;

/**
 * Batches per table per run: 100,000 rows. A larger backlog drains over the next runs rather
 * than in one sitting that holds the database's attention for minutes.
 */
export const RETENTION_MAX_BATCHES = 200;

/** Every six hours. Retention is measured in days, so this is precise enough and cheap. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long a window is announced before anything under it is hidden. */
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
  /** Holds only the owning service can express. See `RetentionHold`. */
  holds?: readonly RetentionHold[];
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
 * The open-report hold alone: true while no pending report names the row `row` qualifies in
 * `table`. The first part of every `holdClause`, and exported so the other deletes of player
 * content — the character purge and the orphan sweep (`lib/orphanSweep.ts`, MICA-292) — keep
 * reported evidence by the same predicate retention does rather than a second copy of it.
 */
export const openReportHold = (table: string, row: string): { sql: string; params: unknown[] } => ({
  sql:
    `NOT EXISTS (SELECT 1 FROM \`${REPORTS_TABLE}\` r WHERE r.\`target_table\` = ? ` +
    `AND r.\`target_id\` = ${row}.\`id\` AND ${OPEN_REPORT})`,
  params: [identifier(table, 'a held table')]
});

/**
 * The evidence hold: true while the row `row` qualifies in `table` is neither named by a
 * pending report (`openReportHold`) nor held down by a takedown (MICA-426).
 *
 * A takedown leaves the row `moderated` rather than deleting it, so the audit ledger and the
 * actioned report still point at something, and so a reopen — the content judged safe — can
 * put it back where and as it was. Once its report is actioned the open-report hold no longer
 * names it, so without this every sweep took it at its age and a reopen found nothing. Held
 * for as long as it is moderated: the next sweep after a reopen takes it by its window as
 * usual, which is why a Dark Chat line that would have expired anyway stays expired.
 *
 * Read off the row itself, not off `mica_reports`: `moderated` is written by the takedown and
 * by nothing else, and it is exactly the state a restore needs. Every reportable and retained
 * table is declared, so every one has `status`; a `NULL` status reads as held.
 */
export const evidenceHold = (table: string, row: string): { sql: string; params: unknown[] } => {
  const report = openReportHold(table, row);
  return { sql: `${report.sql} AND ${row}.\`status\` <> 'moderated'`, params: report.params };
};

/**
 * Every hold on `policy.table`, for the row qualifier `row`, with its parameters in order.
 * See the file header for what each one is.
 */
export const holdClause = (
  policy: RetentionPolicy,
  row: string
): { sql: string; params: unknown[] } => {
  const report = evidenceHold(policy.table, row);
  const parts = [report.sql];
  const params: unknown[] = [...report.params];
  for (const ref of liveReferences(policy.table)) {
    parts.push(
      `NOT EXISTS (SELECT 1 FROM \`${ref.child}\` a JOIN \`${ref.parentTable}\` p ` +
        `ON p.\`id\` = a.\`${ref.parentColumn}\` ` +
        `AND p.\`status\` NOT IN ('deleted', '${EXPIRED}', '${ERASED}') ` +
        `WHERE a.\`${ref.column}\` = ${row}.\`id\`)`
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
 * When retention on `table` was last switched off (MICA-428): every window marker announced
 * before it is void. A `retention-off:` id, which the `retention:` pattern does not match.
 */
export const retentionOffMarkerId = (table: string): string => `retention-off:${table}`;

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

/**
 * This table's live markers, exactly: its window in days and its age in seconds. Not one a
 * switch-off voided: announced before the table's off marker (`forgetMarkers`). Strictly
 * before, so an announcement in the same second as the off marker — the run after it — counts.
 */
const readMarkers = async (
  table: string
): Promise<{ id: string; days: number; ageSeconds: number }[]> => {
  const rows = await Database.query<{ id: string; age: number | string | null }[]>(
    `SELECT m.\`id\` AS \`id\`, TIMESTAMPDIFF(SECOND, m.\`applied_at\`, NOW()) AS \`age\` ` +
      `FROM \`${SCHEMA_MIGRATIONS_TABLE}\` m WHERE m.\`id\` LIKE ? ` +
      `AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA_MIGRATIONS_TABLE}\` o ` +
      'WHERE o.`id` = ? AND o.`applied_at` > m.`applied_at`)',
    [markerPattern(table), retentionOffMarkerId(table)]
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
      `[mica] retention: ${table} is inside its announced grace; nothing is hidden before ` +
        `${new Date(Date.now() + remaining).toISOString()}.`
    );
    scheduleGraceEnd(policy, remaining);
    return remaining;
  }

  const count = firstNumber(
    await Database.query(
      `SELECT COUNT(*) AS \`n\` FROM \`${table}\` t WHERE t.\`status\` = 'active' ` +
        `AND t.\`created_at\` < NOW() - INTERVAL ? DAY AND ${hold.sql}`,
      [days, ...hold.params]
    ),
    'n'
  );
  // Refreshed rather than ignored: the only marker of this id that can already be here is one a
  // switch-off voided (`forgetMarkers`), and the new announcement starts its grace now.
  await Database.query(
    `INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?) ` +
      'ON DUPLICATE KEY UPDATE `applied_at` = CURRENT_TIMESTAMP',
    [retentionMarkerId(table, days)]
  );
  console.warn(
    `[mica] retention: ${count} ${table} rows are older than ${days} days and will be hidden ` +
      `from ${new Date(Date.now() + RETENTION_GRACE_MS).toISOString()}. ` +
      `Every row is kept; set ${policy.convar} "0" to keep showing them.`
  );
  scheduleGraceEnd(policy, RETENTION_GRACE_MS);
  return RETENTION_GRACE_MS;
};

/**
 * Retention is off: void every announcement for this table, so switching it back on is a
 * fresh 24 hours with a fresh count rather than a marker from before the owner changed their
 * mind. Observed on every run (start and every six hours).
 *
 * By an off marker, `retention-off:<table>`, never a delete (MICA-428): every window marker
 * announced before it is void (`readMarkers`). Written only while a live marker remains,
 * so a table left off is not rewritten every six hours.
 */
const forgetMarkers = async (policy: RetentionPolicy): Promise<void> => {
  const timerForTable = graceTimers.get(policy.table);
  if (timerForTable !== undefined) {
    clearTimeout(timerForTable);
    graceTimers.delete(policy.table);
  }
  if (!(await ledgerExists())) return;
  if ((await readMarkers(policy.table)).length === 0) return;
  await Database.query(
    `INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?) ` +
      'ON DUPLICATE KEY UPDATE `applied_at` = CURRENT_TIMESTAMP',
    [retentionOffMarkerId(policy.table)]
  );
};

/** Tables with a prune in flight, so a scheduled run and `micamedia prune` never overlap. */
const running = new Set<string>();

/** Whether a prune of `table` is in progress right now. */
export const isRetentionRunning = (table: string): boolean => running.has(table);

/**
 * Prune one table: rows older than its window, in batches, never a held row, never inside a
 * grace, never without its index. **Not a delete** (MICA-428): `active` moves to `expired`,
 * kept for staff and hidden from every player, and a hosted file the row names is kept with it.
 * Returns the rows expired.
 *
 * `created_at`, and only `active` rows: a row the player deleted stays `deleted`, a takedown's
 * stays `moderated`, and an erased one stays `erased`, so each status keeps saying who hid it.
 * The sentence an owner agrees to is "content older than N days is hidden", and the holds are
 * the only exceptions. `updated_at` is pinned: expiring is not an edit.
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
    // Never while the database is behind the code: the status it writes may not exist yet.
    if (!(await statusWritesMayRun(`retention on ${table}`, { [table]: [EXPIRED] }))) return 0;
    if (!(await preflight(policy))) return 0;

    const selectHold = holdClause(policy, 't');
    const updateHold = holdClause(policy, `\`${table}\``);
    if ((await graceRemainingMs(policy, days, selectHold)) > 0) return 0;

    const selectSql =
      `SELECT t.\`id\` FROM \`${table}\` t ` +
      `WHERE t.\`status\` = 'active' AND t.\`created_at\` < NOW() - INTERVAL ? DAY ` +
      `AND ${selectHold.sql} ORDER BY t.\`created_at\`, t.\`id\` LIMIT ${RETENTION_BATCH}`;

    let expired = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const rows = await Database.query<{ id: number }[]>(selectSql, [days, ...selectHold.params]);
      const ids = (Array.isArray(rows) ? rows : [])
        .map((row) => Number(row.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .slice(0, RETENTION_BATCH);
      if (ids.length === 0) return expired;

      const marks = ids.map(() => '?').join(', ');
      // Every hold and the window are asked again, so a report filed since the select wins.
      expired += affectedRows(
        await Database.query(
          `UPDATE \`${table}\` SET \`status\` = ?, \`updated_at\` = \`updated_at\` ` +
            `WHERE \`id\` IN (${marks}) AND \`status\` = 'active' ` +
            `AND \`created_at\` < NOW() - INTERVAL ? DAY ` +
            `AND ${updateHold.sql} LIMIT ${RETENTION_BATCH}`,
          [EXPIRED, ...ids, days, ...updateHold.params]
        )
      );

      if (ids.length < RETENTION_BATCH) return expired;
      await pause();
    }

    console.warn(
      `[${policy.label}] retention reached ${RETENTION_MAX_BATCHES * RETENTION_BATCH} rows in ` +
        `one run; the rest are left for the next run rather than held in one long sitting.`
    );
    return expired;
  } finally {
    running.delete(policy.table);
  }
};

const runOne = async (policy: RetentionPolicy): Promise<number> => {
  try {
    const removed = await pruneTable(policy);
    if (removed > 0) {
      console.log(
        `[${policy.label}] expired ${removed} row(s) older than ${policy.days()} day(s).`
      );
    }
    return removed;
  } catch (error) {
    console.error(`[${policy.label}] retention prune failed:`, traceOf(error));
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
  // After the first-start schema check (MICA-306), and not at all if it refused.
  whenSchemaReady(startRetentionSchedule);
};

on('onResourceStart', onRetentionResourceStart);
