// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from 'node:buffer';
import { Database } from './Database';
import {
  activeKeyId,
  contentContext,
  contentEncryptionEnabled,
  encryptedColumns,
  isSealed,
  loadedKeyIds,
  sealContent,
  sealedKeyId,
  sealedLength,
  tryOpenContent,
  type EncryptedColumn
} from './contentCipher';

/**
 * `micacrypt status` and `micacrypt backfill` (MICA-165): walk every encrypted column and bring
 * each value to the active key — legacy plaintext sealed, an older key's value re-sealed. The
 * same walk is key rotation: put the new key first in the keyring, restart, and backfill.
 *
 * **Never a statement over a whole table.** Each column is read by `id` keyset, a bounded batch
 * at a time, with a yield between batches so the server keeps ticking; each value is written by
 * its own `UPDATE … WHERE id = ?`, which locks one row.
 *
 * **Compare-and-set.** A row is written only if its value, its `citizenid` and its scope columns
 * are still what was read — the value compared as bytes, so an edit that only changed case is a
 * miss rather than something to overwrite. A miss is counted and left for the next run, which
 * will find the new value. `updated_at` is pinned (`= updated_at`): the column is
 * `ON UPDATE CURRENT_TIMESTAMP`, and a message reads as edited when it is later than
 * `created_at`.
 *
 * **Idempotent.** A value already sealed with the active key is left alone, so a second
 * `--apply` writes nothing.
 *
 * Every identifier interpolated below comes from the encrypted-column registry, which checks
 * each one is a lower_snake_case identifier before it is registered; every value is bound.
 */

/** Rows per batch unless `--batch` says otherwise, and the most `--batch` may ask for. */
export const DEFAULT_BATCH = 500;
export const MAX_BATCH = 5000;

/** The DM notification rows whose persisted body predates `''` (MICA-165), by app and kind. */
export interface NotificationScope {
  readonly app: string;
  readonly kind: string;
}

const NOTIFICATIONS_TABLE = 'mica_notifications';

export interface ColumnReport {
  table: string;
  column: string;
  /** The column is not in the database — the table was never created, or `micaschema apply`. */
  missing: boolean;
  /** Rows walked. */
  rows: number;
  /** NULL: nothing to seal. */
  empty: number;
  /** Sealed with the active key, and it opens. */
  active: number;
  /** Sealed with another loaded key, and it opens: a rotation still to run. By key id. */
  older: Record<string, number>;
  /** Plaintext that fits once sealed. */
  legacy: number;
  /** Sealed, and will not open with any loaded key. Left exactly as it is. */
  unreadable: number;
  /** Plaintext, or an older key's plaintext, whose sealed form the column cannot hold. */
  tooLong: number;
  /** Written with the active key (`--apply`). */
  sealed: number;
  /** Changed between the read and the write, so left for the next run (`--apply`). */
  raced: number;
}

export interface NotificationReport {
  /** Rows whose body is not `''` — after `--apply`, the ones the run did not reach. */
  pending: number;
  /** Bodies blanked by this run (`--apply`). */
  blanked: number;
}

/**
 * Where the keyring stands. Only `none` stores new bodies as plaintext: `refused` (the key file
 * is set but unusable) and `missing` (nothing set, but this database already holds ciphertext)
 * both refuse every write of an encrypted column until the key is back.
 */
export type KeyState =
  { kind: 'loaded' } | { kind: 'none' } | { kind: 'refused'; path: string } | { kind: 'missing' };

export interface ContentReport {
  apply: boolean;
  key: KeyState;
  activeKey: string | null;
  loadedKeys: string[];
  columns: ColumnReport[];
  notifications: NotificationReport | null;
}

export interface WalkOptions {
  apply: boolean;
  batch?: number;
  notifications?: NotificationScope | null;
  /** Between batches. A test replaces it; in game it lets a server tick run. */
  pause?: () => Promise<void>;
}

/** Thrown by an `--apply` there is nothing to seal with. Nothing has been written. */
export class NoActiveKeyError extends Error {}

/**
 * Why there is no key: never configured, or configured and refused. The second is not fixed by
 * setting the convar, which is already set — the boot log line says what is wrong with the file.
 */
const keyFilePath = (): string => GetConvar('mica_content_key_file', '').trim();

const keyStateOf = async (active: string | null): Promise<KeyState> => {
  if (active !== null) return { kind: 'loaded' };
  const path = keyFilePath();
  if (path !== '') return { kind: 'refused', path };
  return (await contentEncryptionEnabled()) ? { kind: 'missing' } : { kind: 'none' };
};

const noKeyReason = (): string => {
  const path = keyFilePath();
  if (path === '') {
    return (
      'no content key is loaded: mica_content_key_file is not set. Set it to a key file ' +
      '(micacrypt keygen writes one) and restart the resource.'
    );
  }
  return (
    `no content key is loaded: mica_content_key_file is set to ${path}, but that key file ` +
    "was refused. The 'content encryption' line in the boot log says why; fix the file and " +
    'restart the resource.'
  );
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const q = (identifier: string): string => `\`${identifier}\``;

const utf8Bytes = (text: string): number => Buffer.from(text, 'utf8').length;

/**
 * Whether `plaintext` sealed could overflow a column of `capacity` characters, at the longest
 * key id. The worst case rather than the active key's exact length, so that `status`, a dry run
 * and `--apply` all agree on which rows are refused — the first two cannot seal to measure.
 */
const overflows = (plaintext: string, capacity: number): boolean =>
  sealedLength(utf8Bytes(plaintext)) > capacity;

/**
 * A column's capacity in characters, or null when it does not exist. A sealed value is ASCII,
 * so for `text` (65,535 bytes) and `varchar(n)` alike this is the longest one it can hold.
 */
const capacityOf = async (entry: EncryptedColumn): Promise<number | null> => {
  const rows = await Database.query<{ n: number | string | null }[]>(
    'SELECT `CHARACTER_MAXIMUM_LENGTH` AS `n` FROM information_schema.COLUMNS ' +
      'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `COLUMN_NAME` = ?',
    [entry.table, entry.column]
  );
  const value = Array.isArray(rows) ? rows[0]?.n : null;
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const emptyReport = (entry: EncryptedColumn): ColumnReport => ({
  table: entry.table,
  column: entry.column,
  missing: false,
  rows: 0,
  empty: 0,
  active: 0,
  older: {},
  legacy: 0,
  unreadable: 0,
  tooLong: 0,
  sealed: 0,
  raced: 0
});

type Row = Record<string, unknown> & { id: number };

/** The page after `after`, with every column the value's context binds. */
const page = async (entry: EncryptedColumn, after: number, batch: number): Promise<Row[]> => {
  const columns = ['id', 'citizenid', ...entry.scope, entry.column].map(q).join(', ');
  const rows = await Database.query<Row[]>(
    `SELECT ${columns} FROM ${q(entry.table)} WHERE \`id\` > ? ORDER BY \`id\` LIMIT ?`,
    [after, batch]
  );
  return Array.isArray(rows) ? rows : [];
};

/** Write one value, if the row is still as it was read. */
const compareAndSet = async (
  entry: EncryptedColumn,
  row: Row,
  was: string,
  sealed: string
): Promise<boolean> => {
  const pin = entry.hasUpdatedAt ? ', `updated_at` = `updated_at`' : '';
  const bound = ['citizenid', ...entry.scope];
  // Byte-exact like the body: under the column's collation a citizenid that changed only in
  // case compares equal, and a value sealed for the old one would never open for the new.
  const scope = bound
    .map((name) => ` AND CAST(${q(name)} AS BINARY) <=> CAST(? AS BINARY)`)
    .join('');
  return await Database.update(
    `UPDATE ${q(entry.table)} SET ${q(entry.column)} = ?${pin} ` +
      `WHERE \`id\` = ? AND CAST(${q(entry.column)} AS BINARY) = ?${scope}`,
    [sealed, row.id, was, ...bound.map((name) => row[name] ?? null)]
  );
};

type Verdict =
  | { kind: 'empty' }
  | { kind: 'active' }
  | { kind: 'unreadable' }
  | { kind: 'tooLong' }
  | { kind: 'seal'; plaintext: string; from: string | null };

/** What one stored value is, and what bringing it to the active key would take. */
const judge = (
  entry: EncryptedColumn,
  row: Row,
  active: string | null,
  capacity: number
): Verdict => {
  const stored = row[entry.column];
  if (stored === null || stored === undefined) return { kind: 'empty' };
  const value = typeof stored === 'string' ? stored : String(stored);
  if (!isSealed(value)) {
    return overflows(value, capacity)
      ? { kind: 'tooLong' }
      : { kind: 'seal', plaintext: value, from: null };
  }
  // Null only for a value that did not open — never for one whose text is the padlock, which
  // is re-sealed like any other. A value it could not read is never rewritten.
  const plaintext = tryOpenContent(contentContext(entry, row), value);
  const kid = sealedKeyId(value);
  if (plaintext === null || kid === null) return { kind: 'unreadable' };
  if (kid === active) return { kind: 'active' };
  return overflows(plaintext, capacity)
    ? { kind: 'tooLong' }
    : { kind: 'seal', plaintext, from: kid };
};

const walkColumn = async (
  entry: EncryptedColumn,
  options: Required<Pick<WalkOptions, 'apply' | 'batch' | 'pause'>>,
  active: string | null
): Promise<ColumnReport> => {
  const report = emptyReport(entry);
  const capacity = await capacityOf(entry);
  if (capacity === null) {
    report.missing = true;
    return report;
  }

  let after = 0;
  for (;;) {
    const rows = await page(entry, after, options.batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      report.rows += 1;
      const verdict = judge(entry, row, active, capacity);
      switch (verdict.kind) {
        case 'empty':
          report.empty += 1;
          continue;
        case 'active':
          report.active += 1;
          continue;
        case 'unreadable':
          report.unreadable += 1;
          continue;
        case 'tooLong':
          report.tooLong += 1;
          continue;
      }
      if (verdict.from === null) report.legacy += 1;
      else report.older[verdict.from] = (report.older[verdict.from] ?? 0) + 1;
      if (!options.apply) continue;

      const sealed = await sealContent(contentContext(entry, row), verdict.plaintext);
      if (await compareAndSet(entry, row, String(row[entry.column]), sealed)) report.sealed += 1;
      else report.raced += 1;
    }
    after = Number(rows[rows.length - 1].id);
    if (rows.length < options.batch) break;
    await options.pause();
  }
  return report;
};

const countNotifications = async (scope: NotificationScope): Promise<number> => {
  const rows = await Database.query<{ n: number | string }[]>(
    `SELECT COUNT(*) AS \`n\` FROM \`${NOTIFICATIONS_TABLE}\` ` +
      "WHERE `app` = ? AND `kind` = ? AND `body` <> ''",
    [scope.app, scope.kind]
  );
  return Number((Array.isArray(rows) ? rows[0]?.n : 0) ?? 0) || 0;
};

const affectedRows = (result: unknown): number => {
  const n = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** Blank the bodies a batch at a time, by id keyset, `updated_at` pinned. */
const blankNotifications = async (
  scope: NotificationScope,
  batch: number,
  pause: () => Promise<void>
): Promise<number> => {
  let blanked = 0;
  let after = 0;
  for (;;) {
    const rows = await Database.query<{ id: number }[]>(
      `SELECT \`id\` FROM \`${NOTIFICATIONS_TABLE}\` ` +
        "WHERE `id` > ? AND `app` = ? AND `kind` = ? AND `body` <> '' ORDER BY `id` LIMIT ?",
      [after, scope.app, scope.kind, batch]
    );
    const ids = (Array.isArray(rows) ? rows : []).map((row) => Number(row.id));
    if (ids.length === 0) break;
    const result = await Database.query(
      `UPDATE \`${NOTIFICATIONS_TABLE}\` SET \`body\` = '', \`updated_at\` = \`updated_at\` ` +
        `WHERE \`id\` IN (${ids.map(() => '?').join(', ')}) ` +
        "AND `app` = ? AND `kind` = ? AND `body` <> ''",
      [...ids, scope.app, scope.kind]
    );
    blanked += affectedRows(result);
    after = ids[ids.length - 1];
    if (ids.length < batch) break;
    await pause();
  }
  return blanked;
};

/**
 * Walk every encrypted column: count on a dry run and for `status`, seal and write on `apply`.
 *
 * `--apply` with no active key throws `NoActiveKeyError` before reading a row — there is nothing
 * to seal with, and a run that "succeeded" having sealed nothing would read as done.
 */
export const walkContent = async (options: WalkOptions): Promise<ContentReport> => {
  const batch = options.batch ?? DEFAULT_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
    throw new RangeError(`the batch size is a whole number from 1 to ${MAX_BATCH}.`);
  }
  const active = activeKeyId();
  if (options.apply && active === null) {
    throw new NoActiveKeyError(noKeyReason());
  }
  const key = await keyStateOf(active);
  const loadedKeys = loadedKeyIds();
  const pause = options.pause ?? tick;

  const columns: ColumnReport[] = [];
  for (const entry of encryptedColumns()) {
    columns.push(await walkColumn(entry, { apply: options.apply, batch, pause }, active));
  }

  let notifications: NotificationReport | null = null;
  if (options.notifications) {
    const blanked = options.apply
      ? await blankNotifications(options.notifications, batch, pause)
      : 0;
    notifications = { pending: await countNotifications(options.notifications), blanked };
  }

  return { apply: options.apply, key, activeKey: active, loadedKeys, columns, notifications };
};

const olderText = (older: Record<string, number>): string => {
  const kids = Object.keys(older).toSorted();
  return kids.length === 0 ? '0' : kids.map((kid) => `${older[kid]} (${kid})`).join(', ');
};

/** `micacrypt status`: what each column holds. */
/** The status's first line: which of the four key states holds, and what it means for writes. */
const keyLine = (report: ContentReport): string => {
  switch (report.key.kind) {
    case 'loaded':
      return (
        `[micacrypt] sealing with key '${report.activeKey}'; ` +
        `loaded: ${report.loadedKeys.join(', ')}.`
      );
    case 'none':
      return '[micacrypt] no content key is set; new bodies are stored as plaintext.';
    case 'refused':
      return (
        `[micacrypt] the key file ${report.key.path} was refused (the boot log's 'content ` +
        "encryption' line says why); every write of a body is refused until it is fixed."
      );
    case 'missing':
      return (
        '[micacrypt] this database holds encrypted bodies but mica_content_key_file is not set; ' +
        'every write of a body is refused, and sealed ones read as a padlock, until the key is back.'
      );
  }
};

export const formatStatus = (report: ContentReport): string[] => {
  const lines = [keyLine(report)];
  if (report.columns.length === 0) lines.push('[micacrypt] no encrypted column is registered.');
  for (const c of report.columns) {
    const name = `${c.table}.${c.column}`;
    if (c.missing) {
      lines.push(`[micacrypt] ${name}: not in the database; run micaschema apply.`);
      continue;
    }
    lines.push(
      `[micacrypt] ${name}: ${c.rows} row(s) — active key ${c.active}, older keys ` +
        `${olderText(c.older)}, plaintext ${c.legacy}, unreadable ${c.unreadable}, ` +
        `too long to seal ${c.tooLong}, empty ${c.empty}.`
    );
  }
  if (report.notifications) {
    lines.push(
      `[micacrypt] DM notifications still holding a body: ${report.notifications.pending}.`
    );
  }
  return lines;
};

/** `micacrypt backfill [--apply]`: what was, or would be, written. */
export const formatBackfill = (report: ContentReport): string[] => {
  const verb = report.apply ? 'sealed' : 'would seal';
  const lines = [
    report.apply
      ? `[micacrypt] backfill with key '${report.activeKey}':`
      : `[micacrypt] backfill dry run (nothing written; add --apply)` +
        (report.activeKey === null
          ? ' — no key is loaded, so --apply would refuse:'
          : ` with key '${report.activeKey}':`)
  ];
  for (const c of report.columns) {
    const name = `${c.table}.${c.column}`;
    if (c.missing) {
      lines.push(`[micacrypt] ${name}: not in the database; skipped.`);
      continue;
    }
    const pending = c.legacy + Object.values(c.older).reduce((a, b) => a + b, 0);
    const done = report.apply ? c.sealed : pending;
    const parts = [
      `${verb} ${done} (plaintext ${c.legacy}, older keys ${olderText(c.older)})`,
      `already on the active key ${c.active}`,
      `unreadable ${c.unreadable}`,
      `too long ${c.tooLong}`
    ];
    if (report.apply) parts.push(`changed mid-run, left for the next run ${c.raced}`);
    lines.push(`[micacrypt] ${name}: ${c.rows} row(s) — ${parts.join(', ')}.`);
  }
  if (report.notifications) {
    lines.push(
      report.apply
        ? `[micacrypt] DM notification bodies blanked: ${report.notifications.blanked}; ` +
            `still holding one: ${report.notifications.pending}.`
        : `[micacrypt] DM notification bodies that would be blanked: ` +
            `${report.notifications.pending}.`
    );
  }
  return lines;
};
