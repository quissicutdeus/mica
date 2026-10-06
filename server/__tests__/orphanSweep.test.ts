// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MICA-152: the sweep that replaces the `ON DELETE CASCADE` ESX cannot have.
 *
 * **Every test below is really one test**, asked twenty different ways: does this code
 * delete rows on evidence it does not have? A sweep that reads "I cannot see the owner
 * table" as "everything is an orphan" deletes every row on the server, and the log line
 * says it worked. So the assertions are overwhelmingly of the form "and `Database.query`
 * was never called with a DELETE" — an emptiness-shaped assertion, which is worth being
 * suspicious of, so each fail-closed case also asserts the *reason* the sweep reports
 * rather than only that it removed nothing. A guard that stopped running would still
 * return zero; it would not still name itself.
 *
 * **`FrameworkBridge` is deliberately not mocked.** The framework verdict is the input the
 * worst failure mode turns on — "es_extended has not started yet" reading as "this is a qb
 * server" — so the detection itself has to be under test, not a stand-in for it.
 * `__setResourceLookup` is the seam the bridge already exposes for exactly this.
 *
 * What this suite **cannot** prove, said plainly: no statement here reaches a database.
 * `Database` is mocked, so the SQL is asserted as text. Whether `DELETE … LIMIT` with a
 * correlated `NOT EXISTS` is accepted by MariaDB, whether an empty `users` table really
 * deletes nothing, and whether a mismatched identity really aborts, are all questions for
 * `pnpm test:migrations` against a real server — see the note at the end of the file.
 */
const { dbMock, localHandlers, netHandlers } = vi.hoisted(() => {
  // Keyed to a *list*, not a single handler. Several modules register `onResourceStart`, so
  // a map that kept only the last one would silently hand a test whichever file happened to
  // import last — and a test driving the wrong handler passes for the wrong reason.
  const local = new Map<string, Function[]>();
  const net = new Map<string, Function>();

  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    local.set(event, [...(local.get(event) ?? []), handler]);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };

  const previousNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    net.set(event, handler);
    return typeof previousNet === 'function' ? previousNet(event, handler) : undefined;
  };

  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    localHandlers: local,
    netHandlers: net
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  __setPurgeHookForTests,
  cascadeEdges,
  ownedTables,
  orphanScope,
  sweepOrphanedRows,
  purgeOwnedRows,
  OWNER_OVERRIDE_CONVAR,
  type OwnedTable
} from '../lib/orphanSweep';
import { FrameworkBridge, __setResourceLookup, detectFramework } from '../lib/FrameworkBridge';
import { REPORTABLE } from '../lib/moderation';
import { CHARACTER_EXCEPT } from '../lib/shell';
import { __setSchemaReadyForTests } from '../lib/schemaReady';
import { SELF_SERVICE_EXCEPT } from '../services/Privacy';
import { declaredServices } from '../lib/defineService';
// Populates `declaredServices` — the registry is filled as a side effect of each
// `defineService`, so without this the derivation below has nothing to derive from.
import '../services/index';

const CHARACTER_DELETED_EVENT = 'mica:server:shell:characterDeleted';

/**
 * The question MICA-71 first asked of `mica_media`, now asked of every row the sweep plans and
 * again in its `DELETE`: is this row's owner gone? The owner table is aliased `ow`, because the
 * plan's own statements use `p` for a parent row (MICA-300).
 */
const OWNER_GONE = (row: string) =>
  `NOT EXISTS (SELECT 1 FROM players ow WHERE ow.citizenid = ${row}.\`citizenid\`)`;

/**
 * Retention's open-report hold on a row of `table` (MICA-167), spelled out rather than built
 * with `openReportHold`, so a change to that predicate shows here instead of agreeing with
 * itself. MICA-292 put it on the purge and the sweep.
 */
const REPORT_HOLD = (table: string) =>
  'NOT EXISTS (SELECT 1 FROM `mica_reports` r WHERE r.`target_table` = ? ' +
  `AND r.\`target_id\` = ${table}.\`id\` AND r.\`status\` = 'active' AND r.\`resolution\` = 'pending')`;

/** The tables a player can report, so the ones the purge and the sweep hold rows in. */
const REPORTABLE_TABLES = [
  'mica_accounts',
  'mica_blabber',
  'mica_blabber_dms',
  'mica_marketplace',
  'mica_media',
  'mica_messages'
];

const QB = { table: 'players', column: 'citizenid' };
const ESX = { table: 'users', column: 'identifier' };

/** Pretend qbx_core is running. `exposes` only ever reads one key off the resource. */
const asQb = () =>
  __setResourceLookup((name) => (name === 'qbx_core' ? { GetPlayer: () => null } : undefined));

const asEsx = () =>
  __setResourceLookup((name) =>
    name === 'es_extended'
      ? { getSharedObject: () => ({ GetPlayerFromId: () => null }) }
      : undefined
  );

/** No framework has answered yet — the boot-order window, and the dangerous one. */
const asUnknown = () => __setResourceLookup(() => undefined);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The planned delete's first read of a table: its rows, and whether each may go. */
const isPlan = (sql: string): boolean =>
  sql.startsWith('SELECT t.`id` AS `id`, ') && sql.includes(' AS `go`, ');

const deletes = (): string[] =>
  dbMock.query.mock.calls
    .map((call: any[]) => String(call[0]))
    .filter((sql) => sql.trimStart().startsWith('DELETE'));

/**
 * A server where everything is answerable: characters exist, micaOS has rows, and the
 * sampled identities are found on the other side. Every fail-closed test below breaks
 * exactly one of those and asserts nothing is deleted.
 */
/** The owner column's live collation as `information_schema` answers it (MICA-299). */
const UNICODE_CI = { collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4' };
const UCA1400 = { collation: 'utf8mb4_uca1400_ai_ci', charset: 'utf8mb4' };

const healthyServer = (
  options: { matched?: number; removedPerTable?: number; collation?: unknown } = {}
) => {
  const { matched = 3, removedPerTable = 0, collation = UNICODE_CI } = options;
  dbMock.single.mockImplementation(async (sql: string) => {
    if (sql.includes('AS total')) return { total: 120 };
    if (sql.includes('AS matched')) return { matched };
    if (sql.includes('AS collation')) {
      if (collation instanceof Error) throw collation;
      return collation;
    }
    throw new Error(`unexpected single(): ${sql}`);
  });
  dbMock.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) {
      return [{ owner: 'CID_A' }, { owner: 'CID_B' }];
    }
    // The plan (MICA-300): one orphaned row in every table, none held, nothing referencing it.
    if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
    if (sql.startsWith('SELECT')) return [];
    if (sql.trimStart().startsWith('DELETE')) return { affectedRows: removedPerTable };
    throw new Error(`unexpected query(): ${sql}`);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  asQb();
  // The start-up sweep waits for the first-start schema check (MICA-306); settle it as an
  // existing database, so driving the hook issues none of the check's queries.
  __setSchemaReadyForTests({ kind: 'existing' });
});

afterEach(() => {
  __setResourceLookup();
});

describe('which tables the sweep covers, and how that set is derived', () => {
  /**
   * The gate that makes the derivation trustworthy, and the reason there is no hand-written
   * list to review. A hand-written list goes stale the next time somebody declares a
   * service, and it goes stale *silently* — the new table is simply never swept, which
   * looks exactly like a table with nothing to sweep.
   *
   * `mica.sql` is the committed artifact an operator imports, so holding the swept set
   * against it asserts the thing that actually matters: every table that carries an owner
   * is covered, whether a declaration produced it or a hand-written file did. That is how
   * `mica_audit_logs` — the one table with no `defineService` behind it — is kept honest
   * rather than trusted to a comment.
   */
  it('covers exactly the tables in the committed mica.sql that carry a citizenid', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'mica.sql'), 'utf8');

    const withOwner = new Set<string>();
    let current: string | null = null;
    for (const line of sql.split('\n')) {
      const created = line.match(/^CREATE TABLE IF NOT EXISTS `([a-z0-9_]+)`/i);
      if (created) current = created[1];
      if (current && /^\s+`citizenid` varchar/.test(line)) withOwner.add(current);
    }

    // An emptiness-shaped assertion that quietly matched nothing would pass forever.
    expect(withOwner.size).toBeGreaterThan(20);
    expect(
      ownedTables()
        .map((t) => t.table)
        .toSorted()
    ).toEqual([...withOwner].toSorted());
  });

  /**
   * MICA-300, from review. The foreign keys onto `players` gave every table an index on
   * `citizenid` whether one was declared or not; `mica_messages_reactions` had no other. Without
   * one, each plan of that table — by a citizenid, or by an owner being gone — is a full scan.
   */
  it('finds an index starting with the owner column on every owned table in mica.sql', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'mica.sql'), 'utf8');
    const bodies = new Map(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)` \(([\s\S]*?)\n\) ENGINE/g)].map((m) => [
        m[1],
        m[2]
      ])
    );
    const unindexed = ownedTables().filter(({ table, column }) => {
      const body = bodies.get(table) ?? '';
      return !new RegExp(`KEY \`\\w+\` \\(\`${column}\``).test(body);
    });
    expect(unindexed).toEqual([]);
  });

  it('reaches the four child tables that carry their own owner key', () => {
    const tables = ownedTables().map((t) => t.table);
    // DDL-only — no repository, no events — so a derivation that walked only
    // `declaredServices[].table` would miss every one of them.
    for (const table of [
      'mica_messages_participants',
      'mica_messages_attachments',
      'mica_marketplace_attachments',
      'mica_blabber_attachments'
    ]) {
      expect(tables, table).toContain(table);
    }
  });

  it('leaves the child tables that cascade off micaOS’s own rows alone', () => {
    const tables = ownedTables().map((t) => t.table);
    // These key on `mica_accounts(id)` / `mica_blabber(id)`, whose foreign keys survive
    // on ESX. They carry no citizenid, so there is nothing here to sweep them by, and the
    // parent's DELETE is what takes them — which is why the sweep must never use TRUNCATE
    // or disable foreign key checks.
    for (const table of [
      'mica_account_blocks',
      'mica_account_follows',
      'mica_account_reactions',
      'mica_blabber_ears',
      'mica_blabber_tags',
      'mica_hodlr_price_history'
    ]) {
      expect(tables, table).not.toContain(table);
    }
  });

  it('names the audit ledger, which no declaration produces', () => {
    expect(ownedTables().map((t) => t.table)).toContain('mica_audit_logs');
  });

  it('keys on the citizenid column itself, never on a citizenid-shaped one', () => {
    // `mica_reports.target_author` is a varchar(50) holding a citizenid with no foreign
    // key, deliberately: evidence has to outlive the character it names. A derivation that
    // matched on shape would sweep reports by their subject.
    expect(ownedTables().every((t) => t.column === 'citizenid')).toBe(true);
  });
});

describe('the owner table comes from the framework, never from probing which table exists', () => {
  it('answers players/citizenid on qb', () => {
    asQb();
    expect(detectFramework()).toBe('qb');
    expect(FrameworkBridge.ownerTable()).toEqual(QB);
  });

  it('answers users/identifier on es_extended', () => {
    asEsx();
    expect(detectFramework()).toBe('esx');
    expect(FrameworkBridge.ownerTable()).toEqual(ESX);
  });

  it('answers nothing at all when no framework has started yet', () => {
    asUnknown();
    expect(detectFramework()).toBe('unknown');
    expect(FrameworkBridge.ownerTable()).toBeNull();
  });

  it('lets a qb core win when both are installed, matching getPlayer', () => {
    __setResourceLookup((name) => {
      if (name === 'qbx_core') return { GetPlayer: () => null };
      if (name === 'es_extended') return { getSharedObject: () => ({}) };
      return undefined;
    });
    expect(FrameworkBridge.ownerTable()).toEqual(QB);
  });
});

describe('fail-closed: nothing is deleted on evidence the sweep does not have', () => {
  /**
   * The one that loses a server's whole database, and the one no other test would catch.
   *
   * FiveM starts resources in `server.cfg` order and `ensure mica` above
   * `ensure es_extended` is legal. If "not started yet" fell back to qb, an ESX box with a
   * leftover non-empty `players` table from an old qb install would pass the population
   * guard, compare ESX identifiers against qb citizenids, find every row unowned, and
   * delete all twenty-two tables at boot.
   */
  it('skips entirely when the framework has not answered yet', async () => {
    asUnknown();
    healthyServer({ removedPerTable: 5 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('unknown-framework');
    expect(result.removed).toBe(0);
    // Not one statement of any kind: it never even asked how many characters there are,
    // because it does not know which table would answer.
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('skips when the owner table cannot be read at all', async () => {
    dbMock.single.mockRejectedValue(new Error('Table mica.players doesn’t exist'));

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('skips when the owner table is empty', async () => {
    dbMock.single.mockResolvedValue({ total: 0 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-empty');
    expect(deletes()).toEqual([]);
  });

  it('skips when the owner count is not a number at all', async () => {
    // A driver answering something unrecognised is "I do not know", never "there are none".
    dbMock.single.mockResolvedValue({ total: 'plenty' });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-empty');
    expect(deletes()).toEqual([]);
  });

  it('skips when the owner row itself comes back missing', async () => {
    dbMock.single.mockResolvedValue(undefined);

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-empty');
    expect(deletes()).toEqual([]);
  });

  it('skips when it cannot sample micaOS’s own rows', async () => {
    dbMock.single.mockResolvedValue({ total: 120 });
    dbMock.query.mockRejectedValue(new Error('connection lost'));

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('skips when the sample comes back in a shape it does not recognise', async () => {
    // The same absence-of-evidence mistake one level down: "the driver gave me something I
    // do not understand" must not become "this server has no rows".
    dbMock.single.mockResolvedValue({ total: 120 });
    dbMock.query.mockResolvedValue({ affectedRows: 3 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('does nothing when micaOS holds no rows to sweep', async () => {
    dbMock.single.mockResolvedValue({ total: 120 });
    dbMock.query.mockResolvedValue([]);

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('nothing-owned');
    expect(deletes()).toEqual([]);
  });

  /**
   * The belt-and-braces guard, and the only one that catches a reachable, populated,
   * *wrong* owner table — a half-started framework, an ESX box carrying a stale `players`,
   * or an identifier silently truncated into `varchar(50)` on the way in (MICA-158).
   * "Every single row on this server is an orphan" is not a thing that happens.
   */
  it('refuses when not one sampled character exists in the owner table', async () => {
    healthyServer({ matched: 0, removedPerTable: 500 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('identity-mismatch');
    expect(result.removed).toBe(0);
    expect(deletes()).toEqual([]);
  });

  it('refuses when the identity check itself cannot be answered', async () => {
    dbMock.single.mockImplementation(async (sql: string) => {
      if (sql.includes('AS total')) return { total: 120 };
      throw new Error('collation mismatch');
    });
    dbMock.query.mockResolvedValue([{ owner: 'CID_A' }]);

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('proceeds once a single sampled character is found, and only then', async () => {
    healthyServer({ matched: 1, removedPerTable: 2 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    expect(deletes().length).toBe(ownedTables().length);
  });
});

/**
 * MICA-159. MICA-152 above resolves the owner table from the three-state framework
 * verdict; this convar is a convenience layered on top for the non-standard setup that
 * verdict cannot cover — a fork, a custom identity resource, a framework migration in
 * progress. Every "fails closed" case here is really the same property the rest of this file
 * is about: an unverified value must never be trusted to decide which rows get deleted, so an
 * invalid override skips the sweep outright rather than quietly falling back to the framework
 * verdict — falling back would make a typo in the convar silently sweep the *wrong* table.
 */
describe('the owner-table override convar (MICA-159)', () => {
  const withOverride = (value: string) => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === OWNER_OVERRIDE_CONVAR ? value : fallback;
  };

  afterEach(() => {
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
  });

  it('empty means "use the framework verdict", not "skip the sweep"', async () => {
    withOverride('');
    healthyServer({ matched: 1, removedPerTable: 2 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    expect(deletes().length).toBe(ownedTables().length);
    // Nothing to verify against information_schema when there is no override at all.
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('a valid override replaces the framework verdict as the owner table', async () => {
    withOverride('custom_characters.character_id');
    healthyServer({ matched: 1, removedPerTable: 2 });
    dbMock.scalar.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT DATABASE()') return 'mica_db';
      if (sql.includes('information_schema.COLUMNS')) return 1;
      throw new Error(`unexpected scalar(): ${sql}`);
    });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    expect(deletes().length).toBeGreaterThan(0);
    // Every DELETE checks existence against the overridden table, not `players`.
    for (const sql of deletes()) {
      expect(sql).toContain('FROM custom_characters ow');
      expect(sql).toContain('ow.character_id');
    }
  });

  it('fails closed on a malformed value, never falling through to the framework verdict', async () => {
    withOverride('not-a-table-and-column');
    healthyServer({ removedPerTable: 5 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-override-invalid');
    expect(deletes()).toEqual([]);
    // The shape alone was enough to refuse it — never even asked information_schema.
    expect(dbMock.scalar).not.toHaveBeenCalled();
    // And never consulted the framework verdict either, which is the whole point of
    // failing closed rather than falling back to it.
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('fails closed on a table.column that does not exist in this database', async () => {
    withOverride('players.no_such_column');
    healthyServer({ removedPerTable: 5 });
    dbMock.scalar.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT DATABASE()') return 'mica_db';
      if (sql.includes('information_schema.COLUMNS')) return null; // not found
      throw new Error(`unexpected scalar(): ${sql}`);
    });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-override-invalid');
    expect(deletes()).toEqual([]);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('fails closed when the override cannot be verified against information_schema at all', async () => {
    withOverride('custom_characters.character_id');
    healthyServer({ removedPerTable: 5 });
    dbMock.scalar.mockRejectedValue(new Error('connection lost'));

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-override-invalid');
    expect(deletes()).toEqual([]);
  });

  it('sweeps normally once the override convar is cleared again', async () => {
    withOverride('');
    healthyServer({ matched: 1, removedPerTable: 2 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    for (const sql of deletes()) {
      expect(sql).toContain('FROM players ow');
    }
  });
});

describe('the owner verdict is resolved once, not per table', () => {
  /**
   * Twenty-two independent resolutions are twenty-two chances for one to disagree with the
   * other twenty-one — and the one that disagrees is the one that deletes.
   */
  it('asks how many characters exist exactly once for a whole sweep', async () => {
    healthyServer({ removedPerTable: 1 });

    await sweepOrphanedRows();

    const counts = dbMock.single.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('AS total')
    );
    expect(counts).toHaveLength(1);
    expect(ownedTables().length).toBeGreaterThan(20);
  });

  it('samples identities exactly once, from the first table that has any', async () => {
    healthyServer({ removedPerTable: 1 });

    await sweepOrphanedRows();

    // The media collect (MICA-292) is a `SELECT DISTINCT` too, of URLs rather than owners.
    const samples = dbMock.query.mock.calls.filter(
      (call: any[]) =>
        String(call[0]).startsWith('SELECT DISTINCT') && String(call[0]).includes('AS owner')
    );
    expect(samples).toHaveLength(1);
  });
});

describe('the statement itself', () => {
  const statementFor = async (table: string): Promise<[string, unknown[]]> => {
    healthyServer({
      matched: 1,
      removedPerTable: 1,
      collation: { collation: null, charset: null }
    });
    await sweepOrphanedRows();
    const call = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith(`DELETE FROM ${table} `)
    )!;
    return [String(call[0]), call[1]];
  };

  it('asks MICA-71’s question of every row it deletes, in the DELETE itself, by planned id', async () => {
    const [sql, params] = await statementFor('mica_media');

    expect(sql.startsWith(`DELETE FROM mica_media WHERE ${OWNER_GONE('mica_media')} AND `)).toBe(
      true
    );
    expect(sql).toContain('mica_media.`id` IN (?)');
    expect(params[0]).toBe(1);
  });

  it('keeps a reported row out of a reportable table’s sweep (MICA-292)', async () => {
    const [sql, params] = await statementFor('mica_media');

    expect(sql).toContain(REPORT_HOLD('mica_media'));
    expect(params).toContain('mica_media');
  });

  it('holds nothing on a table no report can name', async () => {
    const [sql] = await statementFor('mica_notes');

    expect(sql).not.toContain('mica_reports');
  });

  it('asks the ESX question of the ESX table', () => {
    const { sql } = orphanScope(ESX, null).owns('mica_notes', 'citizenid');

    expect(sql).toBe(
      'NOT EXISTS (SELECT 1 FROM users ow WHERE ow.identifier = mica_notes.`citizenid`)'
    );
  });

  it('never uses NOT IN', async () => {
    // `NOT IN` against a subquery holding a single NULL is unknown for every row and
    // deletes nothing at all — a prune that quietly does nothing reads exactly like one
    // that had nothing to do.
    await statementFor('mica_notes');
    for (const call of dbMock.query.mock.calls) expect(String(call[0])).not.toContain('NOT IN');
  });

  it('refuses to build SQL from anything that is not a plain identifier', () => {
    // Nothing off the wire can reach here today. The guard is at the point of
    // concatenation because that is the line the next person to add a parameter reads.
    expect(() => orphanScope({ table: 'players; DROP TABLE x', column: 'c' }, null)).toThrow(
      /plain identifier/
    );
    expect(() => orphanScope(QB, null).owns('t', '*')).toThrow(/plain identifier/);
    expect(() => orphanScope({ table: 'players', column: 'a b' }, null).owns('t', 'c')).toThrow(
      /plain identifier/
    );
  });
});

/**
 * MICA-299. On ESX with a MariaDB 11.4+ `users` left on the server default collation, every
 * sweep statement was errno 1267 "Illegal mix of collations" against micaOS's pinned
 * `utf8mb4_unicode_ci`, and the sweep deleted nothing. The comparison now runs in the owner
 * column's live collation, applied to micaOS's side so the owner's key stays usable.
 */
describe('comparing across collations (MICA-299)', () => {
  const COLLATED = (column: string) =>
    `ow.identifier = CONVERT(${column} USING utf8mb4) COLLATE utf8mb4_uca1400_ai_ci`;

  let errors: ReturnType<typeof vi.spyOn>;
  let warnings: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    asEsx();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    warnings.mockRestore();
  });

  it("converts micaOS's side into the owner's collation and leaves the owner column bare", () => {
    const { sql } = orphanScope(ESX, UCA1400).owns('mica_notes', 'citizenid');

    expect(sql).toBe(
      `NOT EXISTS (SELECT 1 FROM users ow WHERE ${COLLATED('mica_notes.`citizenid`')})`
    );
    // Collating `ow.identifier` would be legal and would scan all of `users` per row.
    expect(sql).not.toMatch(/ow\.identifier COLLATE/);
    expect(sql).not.toMatch(/CONVERT\(ow\./);
  });

  it('converts the character set as well, for an owner column that is not utf8mb4', () => {
    const { sql } = orphanScope(ESX, {
      charset: 'utf8mb3',
      collation: 'utf8mb3_general_ci'
    }).owns('mica_notes', 'citizenid');

    expect(sql).toContain(
      'ow.identifier = CONVERT(mica_notes.`citizenid` USING utf8mb3) COLLATE utf8mb3_general_ci'
    );
  });

  it('refuses to interpolate a collation that is not a plain identifier', () => {
    expect(() =>
      orphanScope(ESX, { charset: 'utf8mb4', collation: 'x; DROP TABLE users' }).owns(
        'mica_notes',
        'citizenid'
      )
    ).toThrow(/plain identifier/);
  });

  it('reads the owner column’s collation once, and every DELETE and collect compares in it', async () => {
    healthyServer({ matched: 1, removedPerTable: 2, collation: UCA1400 });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    expect(result.failures).toEqual([]);
    const reads = dbMock.single.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('AS collation')
    );
    expect(reads).toHaveLength(1);
    expect(reads[0][1]).toEqual(['users', 'identifier']);
    expect(deletes()).toHaveLength(ownedTables().length);
    for (const sql of deletes()) expect(sql).toContain('COLLATE utf8mb4_uca1400_ai_ci');
    // The plan, its links and the hosted-photo collect (MICA-292) read the rows the DELETE is
    // about to take, so each has to ask the same question in the same collation or it errors
    // first.
    const owned = dbMock.query.mock.calls
      .map((call: any[]) => String(call[0]))
      .filter((sql) => sql.startsWith('SELECT') && sql.includes('FROM users ow'));
    expect(owned.filter(isPlan).length).toBe(ownedTables().length);
    for (const sql of owned) expect(sql).toMatch(/COLLATE utf8mb4_uca1400_ai_ci\)/);
    const collect = owned.find((sql) => sql.startsWith('SELECT DISTINCT t.`url`'));
    expect(collect).toContain(COLLATED('t.`citizenid`'));
  });

  it('refuses, loudly and with the reason, when the collation cannot be read', async () => {
    healthyServer({ removedPerTable: 5, collation: new Error('SELECT command denied') });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
    expect(String(warnings.mock.calls.at(-1)?.[0])).toContain('SELECT command denied');
  });

  it('refuses when information_schema does not know the owner column', async () => {
    healthyServer({ removedPerTable: 5, collation: null });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('refuses a collation name it could not safely interpolate', async () => {
    healthyServer({ removedPerTable: 5, collation: { collation: 'a b', charset: 'utf8mb4' } });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBe('owner-unreadable');
    expect(deletes()).toEqual([]);
  });

  it('compares bare against an owner column with no collation at all', async () => {
    healthyServer({ removedPerTable: 1, collation: { collation: null, charset: null } });

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    for (const sql of deletes()) {
      expect(sql).not.toContain('COLLATE');
      expect(sql).toMatch(/ow\.identifier = \w+\.`citizenid`\)/);
    }
  });
});

/** MICA-299: a statement that errors is a logged failure, whoever called. */
describe('a failing statement is logged where it fails', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it('logs a table whose sweep errors, not only returns it', async () => {
    healthyServer({ removedPerTable: 0 });
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) {
        return [{ owner: 'CID_A' }];
      }
      if (sql.includes(' mica_notes ')) throw new Error('Illegal mix of collations');
      return sql.startsWith('SELECT') ? [] : { affectedRows: 0 };
    });

    const result = await sweepOrphanedRows({ label: 'micamedia' });

    expect(result.failures.map((f) => f.table)).toEqual(['mica_notes']);
    const logged = errors.mock.calls.find((call) => String(call[0]).includes('mica_notes'));
    expect(String(logged?.[0])).toContain('[micamedia]');
    expect(logged?.[1]).toBeInstanceOf(Error);
  });

  it('logs a table whose purge errors', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes(' mica_notes ')) throw new Error('lock wait timeout');
      return sql.startsWith('SELECT') ? [] : { affectedRows: 0 };
    });

    const result = await purgeOwnedRows('CID_A');

    expect(result.failures.map((f) => f.table)).toEqual(['mica_notes']);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('mica_notes'))).toBe(true);
  });

  it('logs why an owner override could not be verified', async () => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === OWNER_OVERRIDE_CONVAR ? 'custom_characters.character_id' : fallback;
    dbMock.scalar.mockRejectedValue(new Error('connection lost'));
    try {
      const result = await sweepOrphanedRows();
      expect(result.skipped).toBe('owner-override-invalid');
      expect(errors.mock.calls.some((call) => call[1] instanceof Error)).toBe(true);
    } finally {
      (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
    }
  });
});

describe('deleting in chunks rather than in one long lock', () => {
  const oneTable: OwnedTable[] = [{ table: 'mica_media', column: 'citizenid' }];

  it('names at most five hundred planned ids per statement', async () => {
    healthyServer({ matched: 1 });
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) return [{ owner: 'A' }];
      if (isPlan(sql)) {
        return Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, go: 1, held: 0, ex: 0 }));
      }
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: params.filter((p) => typeof p === 'number').length };
    });

    const result = await sweepOrphanedRows({ only: oneTable });

    expect(result.removed).toBe(1200);
    expect(deletes().map((sql) => sql.match(/`id` IN \(([?, ]+)\)/)![1].split(',').length)).toEqual(
      [500, 500, 200]
    );
  });
});

describe('one table failing does not stop the others', () => {
  it('records the failure and sweeps the rest', async () => {
    healthyServer({ removedPerTable: 2 });
    const failing = 'mica_notes';
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) return [{ owner: 'A' }];
      if (sql.includes(` ${failing} `)) throw new Error(`Table '${failing}' doesn't exist`);
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 2 };
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepOrphanedRows();
    errors.mockRestore();

    expect(result.failures.map((f) => f.table)).toEqual([failing]);
    expect(result.removed).toBe((ownedTables().length - 1) * 2);
  });

  /**
   * MICA-300. A table that cannot be planned has unknown held rows, so anything hanging off it
   * might be evidence: it and everything under it stay, each said as a failure, and the rest
   * still goes.
   */
  it('keeps everything under a table it could not plan, and says so', async () => {
    healthyServer({ removedPerTable: 1 });
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) return [{ owner: 'A' }];
      if (isPlan(sql) && sql.includes('FROM mica_blabber t')) throw new Error('lock wait');
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepOrphanedRows();
    errors.mockRestore();

    const failed = result.failures.map((f) => f.table);
    expect(failed).toContain('mica_blabber');
    expect(failed).toContain('mica_blabber_attachments');
    const deleted = deletes().map((sql) => /^DELETE FROM (\w+)/.exec(sql)![1]);
    expect(deleted).not.toContain('mica_blabber');
    expect(deleted).not.toContain('mica_blabber_attachments');
    expect(deleted).toContain('mica_notes');
  });

  it('never rejects, so resource start cannot be taken down by maintenance', async () => {
    dbMock.single.mockRejectedValue(new Error('nope'));
    dbMock.query.mockRejectedValue(new Error('nope'));

    await expect(sweepOrphanedRows()).resolves.toMatchObject({ removed: 0 });
  });
});

describe('purging one named character', () => {
  /**
   * Deliberately *not* guarded on the owner table, and the asymmetry is the point. The
   * sweep infers which rows are unowned and so must prove it can see the owners; this is
   * told which character is gone by a server resource that just deleted it. There is no
   * absence of evidence to misread, and demanding a readable owner table would break the
   * immediate cleanup on exactly the servers that need it — the ones where the character's
   * row is already gone.
   */
  it('plans and deletes that citizenid’s rows in every owned table, bound as a parameter', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });

    const { removed } = await purgeOwnedRows('CID_Z');

    expect(removed).toBe(ownedTables().length);
    expect(dbMock.single).not.toHaveBeenCalled();
    for (const call of dbMock.query.mock.calls) {
      const sql = String(call[0]);
      const table = /^(?:DELETE FROM|SELECT t\.`id` AS `id`, .* FROM) (mica_[a-z_]+)/.exec(
        sql
      )?.[1];
      if (!table) continue;
      const row = sql.startsWith('DELETE') ? table : 't';
      expect(sql, sql).toContain(`${row}.\`citizenid\` = ?`);
      expect(call[1], sql).toContain('CID_Z');
      // A reportable table keeps a reported row (MICA-292); no other one is held.
      expect(sql.includes(REPORT_HOLD(row)), sql).toBe(REPORTABLE_TABLES.includes(table));
    }
    expect(deletes()).toHaveLength(ownedTables().length);
  });

  it('holds reported rows in exactly the tables a player can report', () => {
    expect(Object.keys(REPORTABLE()).toSorted()).toEqual(REPORTABLE_TABLES);
  });

  it('does nothing for an empty or non-string citizenid', async () => {
    expect(await purgeOwnedRows('   ')).toEqual({ removed: 0, kept: 0, failures: [] });
    expect(await purgeOwnedRows(undefined as unknown as string)).toEqual({
      removed: 0,
      kept: 0,
      failures: []
    });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('reports a failing table rather than abandoning the purge', async () => {
    const failing = 'mica_notes';
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(`DELETE FROM ${failing} `)) throw new Error('gone');
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { removed, failures } = await purgeOwnedRows('CID_Z');
    errors.mockRestore();

    expect(failures.map((f) => f.table)).toEqual([failing]);
    expect(removed).toBe(ownedTables().length - 1);
  });
});

/**
 * MICA-168: a player deleting their own data. `purgeOwnedRows` with options is a different path
 * (`purgeCascadeSafe`): it plans by id, then deletes children first. The character purge above
 * is untouched, and the first test here pins that.
 */
describe("a player's own delete", () => {
  /**
   * A database that answers the plan: `plan[table]` for the owner's rows (none by default),
   * `links['child.column']` for the rows referencing them, and a `DELETE` removes every id it
   * names unless `deleteResult` says otherwise.
   */
  const fakeDb = ({
    plan = {},
    links = {},
    deleteResult,
    reported = new Map<string, Set<number>>()
  }: {
    plan?: Record<string, { id: number; go: number; held: number; ex: number }[]>;
    links?: Record<string, { id?: number; ref: number }[]>;
    deleteResult?: (table: string, ids: number[]) => number;
    /** Rows under an open report by table; the parent-hold clause is honoured against it. */
    reported?: Map<string, Set<number>>;
  }) => {
    // What is still in each table, so a pass's read-back answers what the DELETEs left.
    const alive = new Map(
      Object.entries(plan).map(([table, rows]) => [table, new Set(rows.map((r) => r.id))])
    );
    // Ids are the only numbers a statement binds: the owner and every table name are strings.
    const idsIn = (_sql: string, params: unknown[]): number[] =>
      params.filter((p): p is number => typeof p === 'number');
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      // The sweep's identity sample, for the orphaned-owner case (MICA-300).
      if (sql.startsWith('SELECT DISTINCT') && sql.includes('AS owner')) {
        return [{ owner: 'CID_GONE' }];
      }
      const planned = /^SELECT t\.`id` AS `id`, .* FROM (\w+) t WHERE/.exec(sql)?.[1];
      if (planned) return plan[planned] ?? [];
      const survivors = /^SELECT t\.`id` AS `id` FROM (\w+) t WHERE/.exec(sql)?.[1];
      if (survivors) {
        return idsIn(sql, params)
          .filter((id) => alive.get(survivors)?.has(id))
          .map((id) => ({ id }));
      }
      const link = /c\.`(\w+)` AS `ref` FROM `(\w+)` c/.exec(sql);
      if (link) return links[`${link[2]}.${link[1]}`] ?? [];
      if (sql.startsWith('SELECT')) return [];
      const table = /^DELETE FROM (\w+)/.exec(sql)![1];
      // `parentHold`: a row whose reportable parent is reported stays, when the statement asks.
      const heldByParent = (id: number): boolean =>
        [...sql.matchAll(/FROM `(\w+)` pp JOIN `\w+` cc ON cc\.`(\w+)` = pp\.`id`/g)].some(
          ([, parent, col]) =>
            (links[`${table}.${col}`] ?? []).some(
              (link) => link.id === id && reported.get(parent)?.has(link.ref)
            )
        );
      const named = idsIn(sql, params).filter(
        (id) => alive.get(table)?.has(id) && !heldByParent(id)
      );
      const n = deleteResult ? deleteResult(table, named) : named.length;
      for (const id of named.slice(0, n)) alive.get(table)?.delete(id);
      return { affectedRows: n };
    });
  };
  const deletedIds = (table: string): number[] =>
    dbMock.query.mock.calls
      .filter((c: any[]) => String(c[0]).startsWith(`DELETE FROM ${table} `))
      .flatMap((c: any[]) => (c[1] as unknown[]).filter((p): p is number => typeof p === 'number'));
  const row = (id: number, over: Partial<{ go: number; held: number; ex: number }> = {}) => ({
    id,
    go: 1,
    held: 0,
    ex: 0,
    ...over
  });
  const cascade = { cascade: { dependents: [] as string[] } };

  it('deletes by id and owner, children before parents, with the guard still in the statement', async () => {
    fakeDb({
      plan: { mica_messages_conversations: [row(50)], mica_messages: [row(501)] },
      links: { 'mica_messages.conversation_id': [{ id: 501, ref: 50 }] }
    });

    const result = await purgeOwnedRows('CID_Z', cascade);

    expect(result).toEqual({ removed: 2, kept: 0, failures: [] });
    const order = deletes().map((sql) => /^DELETE FROM (\w+)/.exec(sql)![1]);
    expect(order.indexOf('mica_messages')).toBeLessThan(
      order.indexOf('mica_messages_conversations')
    );
    const parent = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('DELETE FROM mica_messages_conversations ')
    )!;
    expect(String(parent[0])).toMatch(
      /^DELETE FROM mica_messages_conversations WHERE mica_messages_conversations\.`citizenid` = \? AND mica_messages_conversations\.`id` IN \(\?\)/
    );
    expect(String(parent[0])).toContain(
      'NOT EXISTS (SELECT 1 FROM `mica_messages` c WHERE c.`conversation_id` = mica_messages_conversations.`id`)'
    );
    expect(parent[1][0]).toBe('CID_Z');
  });

  it("keeps a parent another player's row references, and counts it as kept", async () => {
    fakeDb({
      plan: { mica_messages_conversations: [row(50)], mica_messages: [row(501)] },
      // 500 is somebody else's message: not in this owner's plan, so it stays.
      links: {
        'mica_messages.conversation_id': [
          { id: 501, ref: 50 },
          { id: 500, ref: 50 }
        ]
      }
    });

    const result = await purgeOwnedRows('CID_Z', cascade);

    expect(deletedIds('mica_messages')).toEqual([501]);
    expect(deletedIds('mica_messages_conversations')).toEqual([]);
    expect(result.kept).toBe(1);
  });

  /**
   * The round-3 must-fix. The attachment is owned and not reportable, so it was deleted before
   * its held post; then nothing referenced the photo and it went, file and all.
   */
  it('keeps what hangs off a held row, and what that references: the photo on a reported post', async () => {
    fakeDb({
      plan: {
        mica_blabber: [row(700, { go: 0, held: 1 })],
        mica_blabber_attachments: [row(9)],
        mica_media: [row(30), row(32)]
      },
      links: {
        'mica_blabber_attachments.blab_id': [{ id: 9, ref: 700 }],
        'mica_blabber_attachments.media_id': [{ id: 9, ref: 30 }]
      }
    });

    const result = await purgeOwnedRows('CID_Z', cascade);

    expect(deletedIds('mica_blabber_attachments')).toEqual([]);
    expect(deletedIds('mica_media')).toEqual([32]);
    expect(deletedIds('mica_blabber')).toEqual([]);
    expect(result).toEqual({ removed: 1, kept: 3, failures: [] });
  });

  it("does not spread evidence upward: a held row's parent stays, its siblings still go", async () => {
    fakeDb({
      plan: {
        mica_messages_conversations: [row(50)],
        mica_messages: [row(501), row(503, { go: 0, held: 1 })]
      },
      links: {
        'mica_messages.conversation_id': [
          { id: 501, ref: 50 },
          { id: 503, ref: 50 }
        ]
      }
    });

    await purgeOwnedRows('CID_Z', cascade);

    expect(deletedIds('mica_messages')).toEqual([501]);
    expect(deletedIds('mica_messages_conversations')).toEqual([]);
  });

  /**
   * Round 4: a report filed between the plan and the delete. The child goes first and its own
   * hold says nothing about its parent, so each child's DELETE also checks every reportable
   * parent it references.
   */
  it("keeps a child whose reportable parent is reported after the plan, in the child's own DELETE", async () => {
    fakeDb({
      plan: {
        mica_blabber_attachments: [row(9)],
        mica_messages_attachments: [row(8)],
        mica_messages_participants: [row(7)]
      }
    });

    await purgeOwnedRows('CID_Z', cascade);

    const statement = (table: string) =>
      dbMock.query.mock.calls.find((c: any[]) => String(c[0]).startsWith(`DELETE FROM ${table} `))!;
    const blab = statement('mica_blabber_attachments');
    expect(String(blab[0])).toContain(
      'NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT pp.`id` AS `k` FROM `mica_blabber` pp ' +
        'JOIN `mica_blabber_attachments` cc ON cc.`blab_id` = pp.`id` WHERE cc.`citizenid` = ? ' +
        `AND NOT (${REPORT_HOLD('pp')})) h WHERE h.\`k\` = mica_blabber_attachments.\`blab_id\`)`
    );
    expect(blab[1]).toEqual(expect.arrayContaining(['CID_Z', 'mica_blabber']));
    // Its media parent is reportable too, so that reference is held the same way.
    expect(String(blab[0])).toContain('FROM `mica_media` pp JOIN `mica_blabber_attachments` cc');
    expect(String(statement('mica_messages_attachments')[0])).toContain(
      'FROM `mica_messages` pp JOIN `mica_messages_attachments` cc ON cc.`message_id` = pp.`id`'
    );
    // A conversation cannot be reported, so its participants carry no such clause.
    expect(String(statement('mica_messages_participants')[0])).not.toContain('pp.`id` AS `k`');
  });

  it('keeps the attachment of a post reported between the plan and the delete', async () => {
    const reported = new Map<string, Set<number>>();
    fakeDb({
      plan: { mica_blabber: [row(706)], mica_blabber_attachments: [row(9)] },
      links: { 'mica_blabber_attachments.blab_id': [{ id: 9, ref: 706 }] },
      reported
    });
    // Nothing was reported when the purge planned; a report lands before it deletes.
    __setPurgeHookForTests(async () => {
      reported.set('mica_blabber', new Set([706]));
    });

    try {
      await purgeOwnedRows('CID_Z', cascade);
    } finally {
      __setPurgeHookForTests();
    }

    // The plan meant to delete the attachment; its own DELETE kept it through `parentHold`.
    const attachment = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('DELETE FROM mica_blabber_attachments ')
    )!;
    expect(attachment[1]).toContain(9);
    expect(
      await dbMock.query(
        'SELECT t.`id` AS `id` FROM mica_blabber_attachments t WHERE t.citizenid = ? AND t.`id` IN (?)',
        ['CID_Z', 9]
      )
    ).toEqual([{ id: 9 }]);
  });

  it('holds a reply whose reportable parent is in its own table the same way', async () => {
    fakeDb({ plan: { mica_blabber: [row(705)] } });

    await purgeOwnedRows('CID_Z', cascade);

    const reply = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('DELETE FROM mica_blabber ')
    )!;
    expect(String(reply[0])).toContain(
      'FROM `mica_blabber` pp JOIN `mica_blabber` cc ON cc.`reply_to` = pp.`id`'
    );
  });

  it('deletes a self-referencing table in passes, and a pass cap reached is a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeDb({
      // Three hundred planned rows, and each pass removes one: still removing when the passes
      // run out, so the cap is what stops it.
      plan: { mica_blabber: Array.from({ length: 300 }, (_, i) => row(1000 + i)) },
      deleteResult: (table) => (table === 'mica_blabber' ? 1 : 0)
    });

    const result = await purgeOwnedRows('CID_Z', cascade);
    errors.mockRestore();

    expect(result.failures.map((f) => f.table)).toEqual(['mica_blabber']);
    expect(String((result.failures[0].error as Error).message)).toContain('passes');
    // A failed table's leftovers are not reported as kept.
    expect(result.kept).toBe(0);
    expect(deletes().filter((sql) => sql.startsWith('DELETE FROM mica_blabber '))).toHaveLength(
      200
    );
  });

  it('settles a self-referencing table once every planned row is gone', async () => {
    let pass = 0;
    fakeDb({
      plan: { mica_blabber: [row(704), row(705)] },
      // The reply goes first, then the post it was keeping.
      deleteResult: (table) => (table === 'mica_blabber' ? (++pass <= 2 ? 1 : 0) : 0)
    });

    const result = await purgeOwnedRows('CID_Z', cascade);

    expect(pass).toBe(2);
    expect(result).toEqual({ removed: 2, kept: 0, failures: [] });
    // The second pass names only what the first left, read back rather than re-sent whole.
    expect(deletedIds('mica_blabber')).toEqual([704, 705, 705]);
  });

  it('throws on a cycle in the foreign keys before any statement runs', async () => {
    const fake = {
      table: 'mica_cycle_a',
      fields: [
        { name: 'b_id', def: { type: 'int', references: { table: 'mica_cycle_b', column: 'id' } } }
      ],
      childTables: [
        {
          name: 'mica_cycle_b',
          columns: {
            citizenid: { type: 'string', citizenId: true },
            a_id: { type: 'int', references: { table: 'mica_cycle_a', column: 'id' } }
          }
        }
      ]
    } as unknown as (typeof declaredServices)[number];
    declaredServices.push(fake);
    try {
      expect(cascadeEdges().some((e) => e.child === 'mica_cycle_b')).toBe(true);
      await expect(purgeOwnedRows('CID_Z', cascade)).rejects.toThrow(/cycle/);
      expect(dbMock.query).not.toHaveBeenCalled();
    } finally {
      declaredServices.splice(declaredServices.indexOf(fake), 1);
    }
  });

  it('skips a whole excepted table, and plans an excepted row as neither going nor kept', async () => {
    fakeDb({ plan: { mica_notes: [row(1), row(2, { go: 0, ex: 1 })] } });

    const result = await purgeOwnedRows('CID_Z', {
      except: [
        { table: 'mica_audit_logs' },
        { table: 'mica_notes', keep: (r) => ({ sql: `${r}.\`title\` = ?`, params: ['k'] }) }
      ],
      cascade: { dependents: [] }
    });

    const statements = dbMock.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(statements.some((sql) => sql.includes('mica_audit_logs'))).toBe(false);
    expect(deletedIds('mica_notes')).toEqual([1]);
    const plan = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).includes('FROM mica_notes t WHERE')
    )!;
    expect(String(plan[0])).toContain('CASE WHEN t.`title` = ? THEN 1 ELSE 0 END AS `ex`');
    expect(result.kept).toBe(0);
  });

  /**
   * MICA-300: the character-deleted purge and the sweep plan the same way. The scenario is
   * MICA-168's: A's post 701 has B's reply 710 under it, A's post 700 is reported and carries
   * A's attachment 9 of A's photo 30, and A's post 702 is unanswered.
   */
  const scenario = () =>
    fakeDb({
      plan: {
        mica_blabber: [row(700, { go: 0, held: 1 }), row(701), row(702)],
        mica_blabber_attachments: [row(9)],
        mica_media: [row(30), row(31)]
      },
      links: {
        // 710 is B's: not in the plan, so it stays and keeps what it references.
        'mica_blabber.reply_to': [{ id: 710, ref: 701 }],
        'mica_blabber_attachments.blab_id': [{ id: 9, ref: 700 }],
        'mica_blabber_attachments.media_id': [{ id: 9, ref: 30 }]
      }
    });
  const expectCascadeSafe = () => {
    // The unanswered post and the unattached photo go; the rest is kept.
    expect(deletedIds('mica_blabber')).toEqual([702]);
    expect(deletedIds('mica_blabber_attachments')).toEqual([]);
    expect(deletedIds('mica_media')).toEqual([31]);
  };

  it("keeps another player's reply, a held post and its attachment when a character is deleted", async () => {
    scenario();

    const result = await purgeOwnedRows('CID_Z');

    expectCascadeSafe();
    // The held post, the one answered, the attachment and its photo.
    expect(result).toEqual({ removed: 2, kept: 4, failures: [] });
  });

  // No collation to reconcile, so the owner comparison reads bare (MICA-299 is covered above).
  const bare = { collation: null, charset: null };

  it('keeps the same rows when the sweep finds the owner gone', async () => {
    healthyServer({ matched: 1, collation: bare });
    scenario();

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    expectCascadeSafe();
    expect(result).toMatchObject({ removed: 2, kept: 4, failures: [] });
    expect(result.byTable).toEqual({ mica_blabber: 1, mica_media: 1 });
    // By the owner being gone, never by a citizenid, and asked again in every DELETE.
    for (const sql of deletes()) {
      const table = /^DELETE FROM (\w+)/.exec(sql)![1];
      expect(sql).toContain(`WHERE ${OWNER_GONE(table)} AND `);
    }
    const plans = dbMock.query.mock.calls.map((c: any[]) => String(c[0])).filter(isPlan);
    expect(plans).toHaveLength(ownedTables().length);
    for (const sql of plans)
      expect(sql).toMatch(new RegExp(` t WHERE ${escape(OWNER_GONE('t'))}$`));
  });

  it('keeps the attachment of a post reported mid-sweep, in its own DELETE', async () => {
    healthyServer({ matched: 1, collation: bare });
    const reported = new Map<string, Set<number>>();
    fakeDb({
      plan: { mica_blabber: [row(706)], mica_blabber_attachments: [row(9)] },
      links: { 'mica_blabber_attachments.blab_id': [{ id: 9, ref: 706 }] },
      reported
    });
    __setPurgeHookForTests(async () => {
      reported.set('mica_blabber', new Set([706]));
    });
    try {
      await sweepOrphanedRows();
    } finally {
      __setPurgeHookForTests();
    }

    const attachment = dbMock.query.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('DELETE FROM mica_blabber_attachments ')
    )!;
    expect(String(attachment[0])).toContain(
      'FROM `mica_blabber` pp JOIN `mica_blabber_attachments` cc ON cc.`blab_id` = pp.`id` ' +
        `WHERE ${OWNER_GONE('cc')} AND NOT (`
    );
  });

  it('passes the dependents it is given to the sweep, so a like does not keep a post', async () => {
    healthyServer({ matched: 1 });
    fakeDb({ plan: { mica_blabber: [row(702)] } });

    await sweepOrphanedRows({ cascade: { dependents: ['mica_blabber_ears'] } });
    const withDependents = dbMock.query.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((sql) => sql.startsWith('DELETE FROM mica_blabber '))!;
    dbMock.query.mockClear();
    healthyServer({ matched: 1 });
    fakeDb({ plan: { mica_blabber: [row(702)] } });
    await sweepOrphanedRows();
    const without = dbMock.query.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((sql) => sql.startsWith('DELETE FROM mica_blabber '))!;

    expect(withDependents).not.toContain('FROM `mica_blabber_ears` c');
    expect(without).toContain('FROM `mica_blabber_ears` c');
  });
});

describe('the character-deleted hook', () => {
  it('is a local handler, never a net event a modified client could reach', () => {
    // §2.9. `onNet` would hand any player a one-argument purge of anybody else's phone
    // across twenty-two tables. This is the assertion that catches the slip.
    expect(localHandlers.has(CHARACTER_DELETED_EVENT)).toBe(true);
    expect(netHandlers.has(CHARACTER_DELETED_EVENT)).toBe(false);
  });

  /** Every owned table but the moderation ledger, which a deleted character keeps. */
  const purgedTables = () => ownedTables().length - 1;
  const PENDING = "mica_reports.`status` = 'active' AND mica_reports.`resolution` = 'pending'";

  it('purges when told a character is gone, the device included', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });

    localHandlers.get(CHARACTER_DELETED_EVENT)![0]('CID_Z');
    await vi.waitFor(() => expect(deletes().length).toBe(purgedTables()));

    // MICA-168: a player's own delete keeps these; a deleted character does not (MICA-300).
    const tables = deletes().map((sql) => /^DELETE FROM (\w+)/.exec(sql)![1]);
    for (const table of [
      'mica_import_ledger',
      'mica_invoices',
      'mica_phones',
      'mica_phone_numbers',
      'mica_battery',
      'mica_lockscreen'
    ]) {
      expect(tables, table).toContain(table);
    }
    for (const call of dbMock.query.mock.calls) {
      if (String(call[0]).startsWith('DELETE')) expect(call[1][0]).toBe('CID_Z');
    }
  });

  /**
   * MICA-300, the owner's decision: a deleted character's pending reports keep holding what
   * they name until staff resolve them, and their moderation ledger rows are kept for good.
   */
  it('keeps their pending reports and every ledger row, by the same predicate Privacy uses', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });

    localHandlers.get(CHARACTER_DELETED_EVENT)![0]('CID_Z');
    await vi.waitFor(() => expect(deletes().length).toBe(purgedTables()));

    const statements = dbMock.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(statements.some((sql) => sql.includes('mica_audit_logs'))).toBe(false);
    const reports = deletes().find((sql) => sql.startsWith('DELETE FROM mica_reports '))!;
    expect(reports).toContain(`NOT (${PENDING})`);
    expect(CHARACTER_EXCEPT.map(({ table }) => table).toSorted()).toEqual([
      'mica_audit_logs',
      'mica_reports'
    ]);
    // Taken from Privacy's list, not restated, so the two predicates cannot drift.
    for (const entry of CHARACTER_EXCEPT) expect(SELF_SERVICE_EXCEPT).toContain(entry);
  });

  it('keeps the same rows in the start-up sweep, so they are not swept as orphans', async () => {
    healthyServer({ matched: 1, removedPerTable: 1 });

    const handlers = localHandlers.get('onResourceStart') ?? [];
    const sweepStart = handlers.find((fn) => /orphan sweep starting/.test(String(fn)))!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      sweepStart('mica');
      await vi.waitFor(() =>
        expect(log.mock.calls.some((c) => /orphan sweep finished/.test(String(c[0])))).toBe(true)
      );
    } finally {
      log.mockRestore();
    }

    const statements = dbMock.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(statements.some((sql) => sql.includes('mica_audit_logs'))).toBe(false);
    const reports = deletes().find((sql) => sql.startsWith('DELETE FROM mica_reports '))!;
    expect(reports).toContain(`NOT (${PENDING})`);
    expect(reports).toContain('NOT EXISTS (SELECT 1 FROM players ow');
  });

  it('runs the plan with the dependents Privacy names, so a like goes with its post', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });

    localHandlers.get(CHARACTER_DELETED_EVENT)![0]('CID_Z');
    await vi.waitFor(() => expect(deletes().length).toBe(purgedTables()));

    const post = deletes().find((sql) => sql.startsWith('DELETE FROM mica_blabber '))!;
    expect(post).not.toContain('FROM `mica_blabber_ears` c');
    expect(post).not.toContain('FROM `mica_blabber_tags` c');
    // A reply keeps its post, whoever wrote it.
    expect(post).toContain('JOIN `mica_blabber` p ON p.`id` = c.`reply_to`');
  });

  it('ignores a payload that does not name a character', async () => {
    localHandlers.get(CHARACTER_DELETED_EVENT)![0]({ citizenid: 'CID_Z' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dbMock.query).not.toHaveBeenCalled();
  });

  /**
   * oxmysql's `rawQuery` returns without invoking its callback when there is no pool, so a
   * query issued before the connection is up neither resolves nor rejects — it hangs, and
   * `Database` has no timeout. This hook can fire in that window. Safe from deletion, but a
   * sweep that logged only its results would be indistinguishable from one that ran and
   * found nothing, which is silence reading as success.
   *
   * So the pairing is what is asserted: a `starting` line before the first query and a
   * `finished` line after, the second unconditional. A hang shows as the first without the
   * second, which is the only evidence an operator gets.
   */
  it('says it started before it asks anything, and says it finished even at zero', async () => {
    const logged: string[] = [];
    // How many queries had been issued when each line was said.
    const queriesAt: number[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
      queriesAt.push(dbMock.query.mock.calls.length);
    });
    try {
      healthyServer({ removedPerTable: 0 });

      // Picked out by the line it logs rather than by position: several modules register
      // `onResourceStart`, and driving the wrong one would pass for the wrong reason. If
      // this stops matching, the test fails loudly instead of testing nothing.
      const handlers = localHandlers.get('onResourceStart') ?? [];
      const sweepStart = handlers.find((fn) => /orphan sweep starting/.test(String(fn)));
      expect(sweepStart, 'no onResourceStart handler runs the orphan sweep').toBeDefined();
      sweepStart!('mica');
      // Starting is said once the schema check settles (MICA-306), before the first query.
      await vi.waitFor(() =>
        expect(logged.some((line) => /orphan sweep starting over \d+ table\(s\)/.test(line))).toBe(
          true
        )
      );
      const starting = logged.findIndex((line) => /orphan sweep starting/.test(line));
      expect(queriesAt[starting]).toBe(0);
      // Finishing, after a sweep that yields between its statements.
      await vi.waitFor(() =>
        expect(logged.some((line) => /orphan sweep finished: removed 0 row\(s\)/.test(line))).toBe(
          true
        )
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the older media-only hook registered and media-only', async () => {
    // Renaming it would silently switch off cleanup for every owner already wired to it,
    // and widening it would delete more than the caller asked for. It stays as documented.
    expect(localHandlers.has('mica:server:media:characterDeleted')).toBe(true);

    dbMock.query.mockImplementation(async (sql: string) => {
      if (isPlan(sql)) return [{ id: 1, go: 1, held: 0, ex: 0 }];
      if (sql.startsWith('SELECT')) return [];
      return { affectedRows: 1 };
    });
    localHandlers.get('mica:server:media:characterDeleted')![0]('CID_Z');
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));

    // MICA-300: planned like the others, so it holds a reported photo and never cascades into
    // an attachment that still names one.
    const [sql] = deletes();
    expect(sql.startsWith('DELETE FROM mica_media WHERE mica_media.`citizenid` = ? AND ')).toBe(
      true
    );
    expect(sql).toContain(REPORT_HOLD('mica_media'));
    expect(sql).toContain(
      'NOT EXISTS (SELECT 1 FROM `mica_blabber_attachments` c WHERE c.`media_id` = mica_media.`id`)'
    );
    // Only mica_media is planned at all.
    const plans = dbMock.query.mock.calls.map((c: any[]) => String(c[0])).filter(isPlan);
    expect(plans.map((q) => /FROM (\w+) t WHERE/.exec(q)![1])).toEqual(['mica_media']);
  });
});
