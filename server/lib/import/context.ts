// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { Database, type TransactionQuery } from '../Database';
import * as PlayerDirectory from '../PlayerDirectory';
import { readCitizenIdByNumber, readPhoneIdByNumber } from '../phoneNumbers';
import { phoneForCitizen } from '../phoneIdentity';
import { SKIP, type ImportSource } from './report';

/**
 * What every source importer shares (MICA-233): the ledger, identity, and the writers.
 *
 * **Every identifier in this directory is a literal.** Source table names come from a fixed
 * list per importer and micaOS's own tables are spelled out; nothing a source row contains is
 * ever interpolated into SQL, only bound as a value (§2.9). The rows being read are the
 * previous phone's, which is to say another resource's — this is the one sanctioned exception
 * to "never read another resource's tables", and it runs once, from the console.
 */

export const LEDGER_TABLE = 'mica_import_ledger';

/** Keys longer than the ledger column are hashed rather than truncated, so two never collide. */
const KEY_MAX = 64;

export const ledgerKey = (raw: string): string =>
  raw.length <= KEY_MAX ? raw : `sha1:${createHash('sha1').update(raw).digest().toString('hex')}`;

/**
 * Rows per write transaction. Each row is three or four statements, so a chunk is a few hundred
 * statements — far inside `Database`'s 60-second timeout even on a slow disk, and a hundred
 * times fewer round trips than one transaction per row.
 */
const CHUNK = 100;

const LEDGER_INSERT = `INSERT INTO \`${LEDGER_TABLE}\`
  (\`citizenid\`, \`source\`, \`source_table\`, \`source_key\`, \`target_table\`, \`target_id\`)`;

/** What becomes of a queued row: its new id, or null and the reason it was not written. */
type Settle = (id: number | null, reason?: string) => void;

interface Pending {
  sourceTable: string;
  key: string;
  targetTable: string;
  citizenid: string;
  statements: TransactionQuery[];
  settle: Settle;
}

const slot = (sourceTable: string, key: string): string => `${sourceTable}\u0000${key}`;

/**
 * Which source rows have become which micaOS rows, and the queue that writes them.
 *
 * Loaded per source table once, then kept in memory — so the second apply finds everything and
 * writes nothing, and a dry run that meets the same key twice (qb-phone stores every message on
 * both participants' rows) counts it once. A key seen in the database is `already imported`;
 * one first seen during this run is a duplicate inside the source.
 *
 * **A new row and its ledger row always commit together.** `write` queues the row; `flush`
 * sends up to `CHUNK` of them in one `Database.transaction`, each as its own `INSERT`, then
 * `SET @mica_import_id = LAST_INSERT_ID()`, then anything that must land with it (a new
 * thread's participants, which name `@mica_import_id`), then the ledger `INSERT` taking its
 * `target_id` from the same variable. The transaction is a batch and returns no ids, so they
 * are read back from the ledger afterwards. `LAST_INSERT_ID()` and the variable are per
 * connection, and oxmysql runs a transaction on one connection.
 *
 * Either a row and its ledger row both exist or neither does, so nothing is ever left that a
 * re-run would write twice. A failed chunk is retried row by row, so one bad row costs only
 * itself; a timed-out chunk is not retried, because `Database` cannot cancel the statement and
 * it may still commit — it is reported, and the ledger's unique key is what stops a re-run and
 * a late commit from both landing.
 */
export class Ledger {
  private readonly loaded = new Map<string, Map<string, number>>();
  private readonly thisRun = new Set<string>();
  private readonly pending = new Set<string>();
  private queue: Pending[] = [];
  /** Stand-ins for ids a dry run would have created, so a lookup still succeeds. */
  private placeholder = -1;

  constructor(
    readonly source: ImportSource,
    readonly apply: boolean
  ) {}

  private async table(sourceTable: string): Promise<Map<string, number>> {
    let rows = this.loaded.get(sourceTable);
    if (rows) return rows;
    rows = new Map();
    const found = await Database.query<{ source_key: string; target_id: number }[]>(
      `SELECT \`source_key\`, \`target_id\` FROM \`${LEDGER_TABLE}\`
       WHERE \`source\` = ? AND \`source_table\` = ?`,
      [this.source, sourceTable]
    );
    for (const row of found ?? []) rows.set(String(row.source_key), Number(row.target_id));
    this.loaded.set(sourceTable, rows);
    return rows;
  }

  private mark(sourceTable: string, key: string, id: number): number {
    this.loaded.get(sourceTable)?.set(key, id);
    this.thisRun.add(slot(sourceTable, key));
    return id;
  }

  /** The micaOS id a source key became, or null. Writes a queued key first, if it is queued. */
  async lookup(sourceTable: string, rawKey: string): Promise<number | null> {
    const key = ledgerKey(rawKey);
    if (this.pending.has(slot(sourceTable, key))) await this.flush();
    return (await this.table(sourceTable)).get(key) ?? null;
  }

  /** Null when the key is new; otherwise the skip reason that fits. */
  async seen(sourceTable: string, rawKey: string): Promise<string | null> {
    const key = ledgerKey(rawKey);
    if (this.pending.has(slot(sourceTable, key))) return SKIP.duplicateInSource;
    if (!(await this.table(sourceTable)).has(key)) return null;
    return this.thisRun.has(slot(sourceTable, key)) ? SKIP.duplicateInSource : SKIP.alreadyImported;
  }

  /**
   * Queue a new micaOS row and its ledger row. `build` returns the target's `INSERT` first, then
   * anything that lands with it; it runs on apply only (it resolves phones, which may create
   * one). `settle` is told the outcome — at once on a dry run, with a placeholder id, and when
   * the chunk commits on an apply.
   */
  async write(
    sourceTable: string,
    rawKey: string,
    targetTable: string,
    citizenid: string,
    build: () => Promise<TransactionQuery[]>,
    settle: Settle
  ): Promise<void> {
    const key = ledgerKey(rawKey);
    await this.table(sourceTable);
    if (!this.apply) {
      settle(this.mark(sourceTable, key, this.placeholder--));
      return;
    }
    this.queue.push({
      sourceTable,
      key,
      targetTable,
      citizenid,
      statements: await build(),
      settle
    });
    this.pending.add(slot(sourceTable, key));
    if (this.queue.length >= CHUNK) await this.flush();
  }

  /** Write everything queued. Every importer calls this before it reports a table. */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, CHUNK);
      const outcome = await this.run(batch);
      if (outcome === 'ok') {
        await this.settleAll(batch);
      } else if (outcome === 'timeout' || batch.length === 1) {
        const reason = outcome === 'timeout' ? SKIP.writeTimedOut : SKIP.writeFailed;
        for (const row of batch) this.fail(row, reason);
      } else {
        for (const row of batch) {
          const alone = await this.run([row]);
          if (alone === 'ok') await this.settleAll([row]);
          else this.fail(row, alone === 'timeout' ? SKIP.writeTimedOut : SKIP.writeFailed);
        }
      }
    }
  }

  private async run(batch: readonly Pending[]): Promise<'ok' | 'failed' | 'timeout'> {
    const statements: TransactionQuery[] = [];
    for (const row of batch) {
      const [insert, ...rest] = row.statements;
      statements.push(insert, { query: 'SET @mica_import_id = LAST_INSERT_ID()' }, ...rest, {
        query: `${LEDGER_INSERT} VALUES (?, ?, ?, ?, ?, @mica_import_id)`,
        params: [row.citizenid, this.source, row.sourceTable, row.key, row.targetTable]
      });
    }
    try {
      return (await Database.transaction(statements)) ? 'ok' : 'failed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[micaimport] a write of ${batch.length} row(s) failed: ${message}`);
      return /did not answer within/.test(message) ? 'timeout' : 'failed';
    }
  }

  private fail(row: Pending, reason: string): void {
    this.pending.delete(slot(row.sourceTable, row.key));
    row.settle(null, reason);
  }

  /** Read the committed ids back from the ledger, one query per source table in the chunk. */
  private async settleAll(batch: readonly Pending[]): Promise<void> {
    const byTable = new Map<string, Pending[]>();
    for (const row of batch) {
      const list = byTable.get(row.sourceTable) ?? [];
      list.push(row);
      byTable.set(row.sourceTable, list);
    }
    for (const [sourceTable, rows] of byTable) {
      const found = await Database.query<{ source_key: string; target_id: number }[]>(
        `SELECT \`source_key\`, \`target_id\` FROM \`${LEDGER_TABLE}\`
         WHERE \`source\` = ? AND \`source_table\` = ?
           AND \`source_key\` IN (${rows.map(() => '?').join(', ')})`,
        [this.source, sourceTable, ...rows.map((r) => r.key)]
      );
      const ids = new Map((found ?? []).map((r) => [String(r.source_key), Number(r.target_id)]));
      for (const row of rows) {
        this.pending.delete(slot(sourceTable, row.key));
        const id = ids.get(row.key);
        if (id) row.settle(this.mark(sourceTable, row.key, id));
        else row.settle(null, SKIP.writeFailed);
      }
    }
  }

  /**
   * Record that a source row became an **existing** micaOS row — a thread the two phones
   * already share, an account the character already holds. One statement, so nothing to pair.
   *
   * Never aborts the run: a duplicate key means the same source row is already linked (another
   * run got there, or this key repeats in the source), and its id is used; anything else is
   * logged and answers null for the caller to count. On a dry run nothing is written and the id
   * is a placeholder.
   */
  async record(
    sourceTable: string,
    rawKey: string,
    targetTable: string,
    targetId: number | null,
    citizenid: string
  ): Promise<number | null> {
    const key = ledgerKey(rawKey);
    await this.table(sourceTable);
    if (!this.apply || targetId === null) return this.mark(sourceTable, key, this.placeholder--);
    try {
      await Database.insert(`${LEDGER_INSERT} VALUES (?, ?, ?, ?, ?, ?)`, [
        citizenid,
        this.source,
        sourceTable,
        key,
        targetTable,
        targetId
      ]);
      return this.mark(sourceTable, key, targetId);
    } catch (error) {
      const existing = await Database.scalar<number | null>(
        `SELECT \`target_id\` FROM \`${LEDGER_TABLE}\`
         WHERE \`source\` = ? AND \`source_table\` = ? AND \`source_key\` = ? LIMIT 1`,
        [this.source, sourceTable, key]
      ).catch(() => null);
      if (existing) return this.mark(sourceTable, key, Number(existing));
      console.error(`[micaimport] could not record ${sourceTable} ${rawKey} in the ledger:`, error);
      return null;
    }
  }
}

/** Whether a table exists in the database oxmysql is connected to. */
export const tablePresent = async (table: string): Promise<boolean> => {
  const found = await Database.scalar<number | null>(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return Boolean(found);
};

/** Which phone a row lands on, or that the number it came from is now someone else's. */
export type PhoneAnswer = { kind: 'ok'; phoneId: string | null } | { kind: 'reassigned' };

/**
 * Who a source row belongs to, and which of their phones it lands on.
 *
 * **The source's own ownership is the truth for its rows.** An identifier column (qb-phone's
 * `citizenid`, NPWD's `identifier`) is resolved through `PlayerDirectory` and nothing else: if
 * it names nobody, the row has no owner — it is not re-guessed from a phone number. Where the
 * source keys rows by number (lb-phone), its own number → identifier map (`sourceOwners`)
 * answers first, because those numbers are lb-phone's and may since have been handed to
 * somebody else in micaOS or the framework. Only a number the source itself cannot place falls
 * back to `PlayerDirectory` and then `mica_phone_numbers`.
 */
export class Resolver {
  private readonly byCitizen = new Map<string, Promise<string | null>>();
  private readonly byNumber = new Map<string, Promise<string | null>>();
  private readonly phones = new Map<string, Promise<PhoneAnswer>>();

  constructor(
    private readonly sourceOwners: (number: string) => Promise<string[]> = async () => []
  ) {}

  citizen(identifier: unknown): Promise<string | null> {
    const id = typeof identifier === 'string' ? identifier.trim() : '';
    if (!id) return Promise.resolve(null);
    let pending = this.byCitizen.get(id);
    if (!pending) {
      pending = PlayerDirectory.resolve(id).then((entry) => entry?.citizenid ?? null);
      this.byCitizen.set(id, pending);
    }
    return pending;
  }

  number(raw: unknown): Promise<string | null> {
    const number = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (!number) return Promise.resolve(null);
    let pending = this.byNumber.get(number);
    if (!pending) {
      pending = this.resolveNumber(number);
      this.byNumber.set(number, pending);
    }
    return pending;
  }

  private async resolveNumber(number: string): Promise<string | null> {
    for (const identifier of await this.sourceOwners(number)) {
      const citizenid = await this.citizen(identifier);
      if (citizenid) return citizenid;
    }
    const entry = await PlayerDirectory.resolveByPhone(number);
    if (entry) return entry.citizenid;
    const holder = await readCitizenIdByNumber(number);
    return holder ? await this.citizen(holder) : null;
  }

  /** A row's owner: its identifier when the source has one, else its number. */
  async owner(ref: { citizenid?: string | null; number?: string | null }): Promise<string | null> {
    if (ref.citizenid) return await this.citizen(ref.citizenid);
    return ref.number ? await this.number(ref.number) : null;
  }

  /**
   * The phone a row lands on (MICA-282), always derived from the resolved citizen.
   *
   * When the row came with a number and micaOS has a phone on that number, that phone is used
   * only if the citizen holds it; held by anyone else, the answer is `reassigned` and the row is
   * skipped rather than written onto somebody else's phone. Otherwise it is the citizen's own
   * phone — `phoneForCitizen`, on apply only, since it creates an identity phone for a citizen
   * who has none and a dry run must not write (`phoneId` is null then).
   */
  phone(
    citizenid: string,
    number: string | null | undefined,
    apply: boolean
  ): Promise<PhoneAnswer> {
    const key = `${citizenid}\u0000${number ?? ''}\u0000${apply ? 1 : 0}`;
    let pending = this.phones.get(key);
    if (!pending) {
      pending = (async (): Promise<PhoneAnswer> => {
        if (number) {
          const onNumber = await readPhoneIdByNumber(number);
          if (onNumber) {
            const holder = await readCitizenIdByNumber(number);
            if (holder && holder !== citizenid) return { kind: 'reassigned' };
            return { kind: 'ok', phoneId: onNumber };
          }
        }
        return { kind: 'ok', phoneId: apply ? await phoneForCitizen(citizenid) : null };
      })();
      this.phones.set(key, pending);
    }
    return pending;
  }
}

/** A source timestamp as a Date, or null to let the column default to now. */
export const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds or milliseconds: nothing written after 2001 is below 1e12 in milliseconds.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

export const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

/** Split a single display string into a contact's first and last name. */
export const splitName = (display: string): { firstname: string; lastname: string | null } => {
  const trimmed = display.trim();
  const space = trimmed.indexOf(' ');
  if (space < 0) return { firstname: trimmed.slice(0, 50), lastname: null };
  return {
    firstname: trimmed.slice(0, space).slice(0, 50),
    lastname:
      trimmed
        .slice(space + 1)
        .trim()
        .slice(0, 50) || null
  };
};

export interface ImportContext {
  source: ImportSource;
  apply: boolean;
  ledger: Ledger;
  resolver: Resolver;
}
