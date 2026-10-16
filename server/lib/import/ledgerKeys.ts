// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { Database } from '../Database';
import { activeKeyId, contentDigests, loadedKeyIds } from '../contentCipher';

/**
 * The import ledger's keys (MICA-233), and the ones that must not hold what they are built from
 * (MICA-340).
 *
 * A ledger key names the source row a micaOS row came from. Most are a source table's own id.
 * qb-phone's messages have none: each lives in a JSON history on both participants' rows, so
 * its key is the pair, the date, the time, the sender **and the body**, plus an ordinal for two
 * same-minute texts that say the same thing. That key stored as it is would put the body in
 * `mica_import_ledger.source_key`, outside every encrypted column — so for a body-keyed table
 * the stored form is a keyed digest of it instead, under the content key, whenever there is one.
 *
 * Every lookup tries each form a key has ever been stored in, so a re-import never writes a row
 * twice because the ledger's form moved under it:
 *
 * - `hmac:<kid>:<hex>` — new, for a body-keyed table with a key loaded; tried under every key
 *   in the keyring, so a rotation does not orphan entries while the old key is still listed.
 * - the raw key, when it fits the column — every entry written before MICA-340, and new ones
 *   for a body-keyed table only while no key is configured (the bodies are plaintext then too).
 *   `micacrypt backfill --apply` rewrites these into the keyed form.
 * - `sha1:<hex>` — a raw key too long for the column, unkeyed: most of the legacy entries, since
 *   qb-phone's key spends 44 characters before the body starts. The backfill cannot rewrite one
 *   (the digest cannot be undone); a `micaimport --apply` re-run can, for every source row it
 *   still reads, because it holds the raw key — and so can it an entry under an older key.
 *
 * An entry under a key the keyring no longer holds can match nothing, so a run that meets one
 * would import its message again: `micaimport --apply` refuses to start while there are any.
 */

export const LEDGER_TABLE = 'mica_import_ledger';

/** Keys longer than the ledger column are hashed rather than truncated, so two never collide. */
const KEY_MAX = 64;

/** The stored form of a key before MICA-340, and still of every key not built from a body. */
const ledgerKey = (raw: string): string =>
  raw.length <= KEY_MAX ? raw : `sha1:${createHash('sha1').update(raw).digest().toString('hex')}`;

/**
 * The source tables whose ledger keys carry message bodies, by source. A new importer that
 * builds a key from player-written text adds its table here.
 */
const BODY_KEYED_TABLES: ReadonlyMap<string, readonly string[]> = new Map([
  ['qb-phone', ['phone_messages']]
]);

export const isBodyKeyed = (source: string, sourceTable: string): boolean =>
  BODY_KEYED_TABLES.get(source)?.includes(sourceTable) ?? false;

/** What the digest is for: a new meaning is a new string, never a reuse of this one. */
const DIGEST_PURPOSE = 'import-ledger-key v1';

/**
 * 160 bits of the HMAC: as wide as the SHA-1 the column already held, and short enough that
 * `hmac:` and the longest key id (16) still fit the column's 64 characters.
 */
const DIGEST_HEX = 40;

const KEYED_PATTERN = /^hmac:([a-z0-9-]{1,16}):[0-9a-f]{40}$/;

const keyed = (kid: string, digest: { toString(encoding: 'hex'): string }): string =>
  `hmac:${kid}:${digest.toString('hex').slice(0, DIGEST_HEX)}`;

/** The key id a stored key was digested under, or null for a raw or SHA-1 one. */
export const keyedKid = (stored: string): string | null => KEYED_PATTERN.exec(stored)?.[1] ?? null;

/** The body-keyed source tables of one source. */
export const bodyKeyedTables = (source: string): readonly string[] =>
  BODY_KEYED_TABLES.get(source) ?? [];

/**
 * The key ids entries are stored under that the keyring cannot produce, with how many each.
 * Empty when every keyed entry can still be matched.
 */
export const orphanedKeyIds = (stored: Iterable<string>): Map<string, number> => {
  const loaded = new Set(loadedKeyIds());
  const out = new Map<string, number>();
  for (const key of stored) {
    const kid = keyedKid(key);
    if (kid !== null && !loaded.has(kid)) out.set(kid, (out.get(kid) ?? 0) + 1);
  }
  return out;
};

/**
 * Rewrite one entry's key, if it still holds `from` — a compare-and-set by `id`.
 *
 * Compared as `SHA2(source_key, 256)` against a digest computed here, never as the value: `from`
 * is the raw key, body and all, and oxmysql prints a statement's parameters under `mysql_debug`
 * and in its slow-query log. The hash is over the stored bytes, so an entry that changed only in
 * case is a miss too, under the column's case-insensitive collation.
 *
 * `failed` is anything but the unique key: the caller decides whether that ends its run. Never
 * throws with oxmysql's message, which embeds the parameters.
 */
export const rekeyEntry = async (
  id: number,
  from: string,
  to: string
): Promise<'rekeyed' | 'raced' | 'collided' | 'failed'> => {
  const was = createHash('sha256').update(from).digest().toString('hex');
  try {
    const written = await Database.update(
      `UPDATE \`${LEDGER_TABLE}\` SET \`source_key\` = ?
       WHERE \`id\` = ? AND SHA2(\`source_key\`, 256) = ?`,
      [to, id, was]
    );
    return written ? 'rekeyed' : 'raced';
  } catch (error) {
    return /duplicate entry/i.test(String(error)) ? 'collided' : 'failed';
  }
};

/**
 * How one source key is stored, and every form a lookup must try for it.
 *
 * `store` is what a new entry is written as, and the in-run identity of the key: stable for a
 * run, because the keyring is read once. `forms` begins with it.
 */
export const keyForms = (
  source: string,
  sourceTable: string,
  raw: string
): { store: string; forms: string[] } => {
  const legacy = ledgerKey(raw);
  if (!isBodyKeyed(source, sourceTable)) return { store: legacy, forms: [legacy] };
  const digests = contentDigests(DIGEST_PURPOSE, raw).map(({ kid, digest }) => keyed(kid, digest));
  return { store: digests[0] ?? legacy, forms: [...new Set([...digests, legacy])] };
};

/** What a stored key is, for the walk below. */
const kindOf = (stored: string): { kind: 'keyed'; kid: string } | { kind: 'hashed' | 'raw' } => {
  const match = KEYED_PATTERN.exec(stored);
  if (match) return { kind: 'keyed', kid: match[1] };
  return stored.startsWith('sha1:') ? { kind: 'hashed' } : { kind: 'raw' };
};

// ─── the backfill's half ─────────────────────────────────────────────────────────────────────

interface LedgerKeyReport {
  /** The ledger is not in the database: nothing was ever imported, or `micaschema apply`. */
  missing: boolean;
  /** Entries of a body-keyed table walked. */
  rows: number;
  /** Keyed with the active key. */
  active: number;
  /** Keyed with another key, by key id: a re-import still matches them while it is loaded. */
  older: Record<string, number>;
  /** The raw key, body and all: keyed by `--apply`. */
  raw: number;
  /** An unkeyed SHA-1 of a key too long to store: only a `micaimport --apply` re-run keys it. */
  hashed: number;
  /** Rewritten to the active key (`--apply`). */
  rewritten: number;
  /** Changed between the read and the write, so left for the next run (`--apply`). */
  raced: number;
  /** Refused because the keyed form is already an entry: the source row is in the ledger twice. */
  collided: number;
}

const emptyReport = (): LedgerKeyReport => ({
  missing: false,
  rows: 0,
  active: 0,
  older: {},
  raw: 0,
  hashed: 0,
  rewritten: 0,
  raced: 0,
  collided: 0
});

const ledgerPresent = async (): Promise<boolean> => {
  const rows = await Database.query<{ n: number | string }[]>(
    'SELECT COUNT(*) AS `n` FROM information_schema.TABLES ' +
      'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ?',
    [LEDGER_TABLE]
  );
  return Number((Array.isArray(rows) ? rows[0]?.n : 0) ?? 0) > 0;
};

/**
 * Count, and on `apply` key, every entry of a body-keyed table: `micacrypt status` and
 * `micacrypt backfill` call it after the encrypted columns.
 *
 * By `id` keyset, a batch at a time, a pause between batches; each entry written by its own
 * compare-and-set (`rekeyEntry`), so an entry that changed since the read is a miss rather than
 * an overwrite. Only a raw key is ever rewritten — it is the one form the walk can compute a
 * keyed form from. Idempotent: a second `--apply` finds nothing raw.
 *
 * `apply` with no active key throws before reading anything; `micacrypt` refuses that first.
 */
export const walkLedgerKeys = async (options: {
  apply: boolean;
  batch: number;
  pause: () => Promise<void>;
}): Promise<LedgerKeyReport> => {
  const report = emptyReport();
  const active = activeKeyId();
  if (options.apply && active === null) {
    throw new Error('the import ledger cannot be keyed: no content key is loaded.');
  }
  if (!(await ledgerPresent())) {
    report.missing = true;
    return report;
  }
  for (const [source, tables] of BODY_KEYED_TABLES) {
    for (const sourceTable of tables) {
      let after = 0;
      for (;;) {
        const rows = await Database.query<{ id: number; source_key: string }[]>(
          `SELECT \`id\`, \`source_key\` FROM \`${LEDGER_TABLE}\`
           WHERE \`id\` > ? AND \`source\` = ? AND \`source_table\` = ?
           ORDER BY \`id\` LIMIT ?`,
          [after, source, sourceTable, options.batch]
        );
        const page = Array.isArray(rows) ? rows : [];
        if (page.length === 0) break;
        for (const row of page) {
          report.rows += 1;
          const stored = String(row.source_key);
          const kind = kindOf(stored);
          if (kind.kind === 'keyed') {
            if (kind.kid === active) report.active += 1;
            else report.older[kind.kid] = (report.older[kind.kid] ?? 0) + 1;
            continue;
          }
          if (kind.kind === 'hashed') {
            report.hashed += 1;
            continue;
          }
          report.raw += 1;
          if (!options.apply) continue;
          const outcome = await rekeyEntry(
            row.id,
            stored,
            keyForms(source, sourceTable, stored).store
          );
          if (outcome === 'rekeyed') report.rewritten += 1;
          else if (outcome === 'raced') report.raced += 1;
          else if (outcome === 'collided') {
            // Named by id only: the raw key is the very thing this walk keeps out of the log.
            console.error(
              `[micacrypt] import ledger entry ${row.id} could not be keyed: its keyed form is ` +
                'already an entry.'
            );
            report.collided += 1;
          } else {
            throw new Error(`the import ledger entry ${row.id} could not be written.`);
          }
        }
        after = Number(page[page.length - 1].id);
        if (page.length < options.batch) break;
        await options.pause();
      }
    }
  }
  return report;
};

const olderText = (older: Record<string, number>, loaded: readonly string[]): string => {
  const kids = Object.keys(older).toSorted();
  if (kids.length === 0) return '0';
  return kids
    .map((kid) => `${older[kid]} (${kid}${loaded.includes(kid) ? '' : ', not loaded'})`)
    .join(', ');
};

/**
 * The lines `micacrypt` prints for the ledger. An older key that is no longer loaded is named,
 * and so is having no usable key at all: either way `micaimport --apply` refuses to run.
 */
export const formatLedgerKeys = (report: LedgerKeyReport, apply: boolean | null): string[] => {
  const name = `${LEDGER_TABLE} (message keys)`;
  if (report.missing) return [`[micacrypt] ${name}: not in the database; nothing to key.`];
  const loaded = loadedKeyIds();
  const parts = [
    `active key ${report.active}`,
    `older keys ${olderText(report.older, loaded)}`,
    apply === true
      ? `keyed ${report.rewritten} of ${report.raw} in clear`
      : apply === false
        ? `would key ${report.raw} in clear`
        : `in clear ${report.raw}`,
    `unkeyed SHA-1 ${report.hashed} (keyed only by a micaimport --apply re-run)`
  ];
  if (apply === true) {
    parts.push(`changed mid-run, left for the next run ${report.raced}`);
    if (report.collided > 0) parts.push(`already keyed by another entry ${report.collided}`);
  }
  const lines = [`[micacrypt] ${name}: ${report.rows} row(s) — ${parts.join(', ')}.`];
  const older = Object.keys(report.older).toSorted();
  const orphaned = older.filter((kid) => !loaded.includes(kid));
  const listed = older.filter((kid) => loaded.includes(kid));
  if (orphaned.length > 0 && loaded.length === 0) {
    lines.push(
      `[micacrypt] no usable content key is loaded, so the entries keyed with ` +
        `${orphaned.join(', ')} cannot be matched; micaimport --apply refuses to run until the ` +
        'key file is back.'
    );
  } else if (orphaned.length > 0) {
    lines.push(
      `[micacrypt] the key file no longer holds ${orphaned.join(', ')}, so those entries cannot ` +
        'be matched; micaimport --apply refuses to run until that key is back in the key file.'
    );
  }
  if (listed.length > 0) {
    lines.push(
      `[micacrypt] entries keyed with ${listed.join(', ')} match only while that key stays in ` +
        'the key file; a micaimport --apply re-run re-keys those whose source rows it still reads.'
    );
  }
  return lines;
};
