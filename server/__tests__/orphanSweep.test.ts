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
  ownedTables,
  orphanDeleteSql,
  sweepOrphanedRows,
  purgeOwnedRows,
  OWNER_OVERRIDE_CONVAR,
  type OwnedTable
} from '../lib/orphanSweep';
import { FrameworkBridge, __setResourceLookup, detectFramework } from '../lib/FrameworkBridge';
// Populates `declaredServices` — the registry is filled as a side effect of each
// `defineService`, so without this the derivation below has nothing to derive from.
import '../services/index';

const CHARACTER_DELETED_EVENT = 'mica:server:shell:characterDeleted';

/** The historical qb statement, from `pruneOrphanedMedia` as MICA-71 shipped it. */
const MICA_71_MEDIA_DELETE =
  'DELETE FROM mica_media WHERE NOT EXISTS ' +
  '(SELECT 1 FROM players p WHERE p.citizenid = mica_media.citizenid)';

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

const deletes = (): string[] =>
  dbMock.query.mock.calls
    .map((call: any[]) => String(call[0]))
    .filter((sql) => sql.trimStart().startsWith('DELETE'));

/**
 * A server where everything is answerable: characters exist, micaOS has rows, and the
 * sampled identities are found on the other side. Every fail-closed test below breaks
 * exactly one of those and asserts nothing is deleted.
 */
const healthyServer = (options: { matched?: number; removedPerTable?: number } = {}) => {
  const { matched = 3, removedPerTable = 0 } = options;
  dbMock.single.mockImplementation(async (sql: string) => {
    if (sql.includes('AS total')) return { total: 120 };
    if (sql.includes('AS matched')) return { matched };
    throw new Error(`unexpected single(): ${sql}`);
  });
  dbMock.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT')) return [{ owner: 'CID_A' }, { owner: 'CID_B' }];
    if (sql.trimStart().startsWith('DELETE')) return { affectedRows: removedPerTable };
    throw new Error(`unexpected query(): ${sql}`);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  asQb();
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
      expect(sql).toContain('FROM custom_characters p');
      expect(sql).toContain('p.character_id');
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
      expect(sql).toContain('FROM players p');
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

    const samples = dbMock.query.mock.calls.filter((call: any[]) =>
      String(call[0]).startsWith('SELECT DISTINCT')
    );
    expect(samples).toHaveLength(1);
  });
});

describe('the statement itself', () => {
  it('is the statement MICA-71 shipped, on qb, plus a bound on how much it may lock', () => {
    const sql = orphanDeleteSql({ table: 'mica_media', column: 'citizenid' }, QB);

    expect(sql.startsWith(MICA_71_MEDIA_DELETE)).toBe(true);
    expect(sql).toMatch(/ LIMIT \d+$/);
  });

  it('asks the ESX question of the ESX table', () => {
    const sql = orphanDeleteSql({ table: 'mica_notes', column: 'citizenid' }, ESX);

    expect(sql).toContain('FROM users p');
    expect(sql).toContain('p.identifier = mica_notes.citizenid');
  });

  it('never uses NOT IN', () => {
    // `NOT IN` against a subquery holding a single NULL is unknown for every row and
    // deletes nothing at all — a prune that quietly does nothing reads exactly like one
    // that had nothing to do.
    expect(orphanDeleteSql({ table: 'mica_notes', column: 'citizenid' }, QB)).not.toContain(
      'NOT IN'
    );
  });

  it('refuses to build SQL from anything that is not a plain identifier', () => {
    // Nothing off the wire can reach here today. The guard is at the point of
    // concatenation because that is the line the next person to add a parameter reads.
    expect(() =>
      orphanDeleteSql({ table: 'mica_notes; DROP TABLE players; --', column: 'citizenid' }, QB)
    ).toThrow(/plain identifier/);
    expect(() => orphanDeleteSql({ table: 'mica_notes', column: '*' }, QB)).toThrow(
      /plain identifier/
    );
    expect(() =>
      orphanDeleteSql({ table: 'mica_notes', column: 'citizenid' }, { table: 'a b', column: 'c' })
    ).toThrow(/plain identifier/);
  });
});

describe('deleting in chunks rather than in one long lock', () => {
  const oneTable: OwnedTable[] = [{ table: 'mica_media', column: 'citizenid' }];

  const chunkOf = (sql: string): number => Number(sql.match(/LIMIT (\d+)$/)?.[1] ?? 0);

  it('stops as soon as a batch comes back short', async () => {
    healthyServer({ removedPerTable: 1 });

    const result = await sweepOrphanedRows({ only: oneTable });

    expect(result.removed).toBe(1);
    expect(deletes()).toHaveLength(1);
  });

  it('keeps going while every batch comes back full', async () => {
    const chunk = chunkOf(orphanDeleteSql(oneTable[0], QB));
    let issued = 0;
    dbMock.single.mockImplementation(async (sql: string) =>
      sql.includes('AS total') ? { total: 9 } : { matched: 9 }
    );
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT')) return [{ owner: 'CID_A' }];
      issued += 1;
      return { affectedRows: issued < 3 ? chunk : 4 };
    });

    const result = await sweepOrphanedRows({ only: oneTable });

    expect(issued).toBe(3);
    expect(result.removed).toBe(chunk * 2 + 4);
  });
});

describe('one table failing does not stop the other twenty-one', () => {
  it('records the failure and sweeps the rest', async () => {
    healthyServer({ removedPerTable: 2 });
    const failing = ownedTables()[1].table;
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT')) return [{ owner: 'CID_A' }];
      if (sql.includes(` ${failing} `)) throw new Error(`Table '${failing}' doesn't exist`);
      return { affectedRows: 2 };
    });

    const result = await sweepOrphanedRows();

    expect(result.failures.map((f) => f.table)).toEqual([failing]);
    expect(result.removed).toBe((ownedTables().length - 1) * 2);
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
  it('deletes that citizenid’s rows from every owned table, bound as a parameter', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    const { removed } = await purgeOwnedRows('CID_Z');

    const statements = deletes();
    expect(statements).toHaveLength(ownedTables().length);
    expect(removed).toBe(ownedTables().length);
    for (const call of dbMock.query.mock.calls) {
      expect(String(call[0])).toMatch(/^DELETE FROM mica_[a-z_]+ WHERE citizenid = \?$/);
      expect(call[1]).toEqual(['CID_Z']);
    }
  });

  it('does nothing for an empty or non-string citizenid', async () => {
    expect(await purgeOwnedRows('   ')).toEqual({ removed: 0, failures: [] });
    expect(await purgeOwnedRows(undefined as unknown as string)).toEqual({
      removed: 0,
      failures: []
    });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('reports a failing table rather than abandoning the purge', async () => {
    const failing = ownedTables()[0].table;
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes(failing)) throw new Error('gone');
      return { affectedRows: 1 };
    });

    const { removed, failures } = await purgeOwnedRows('CID_Z');

    expect(failures.map((f) => f.table)).toEqual([failing]);
    expect(removed).toBe(ownedTables().length - 1);
  });
});

describe('the character-deleted hook', () => {
  it('is a local handler, never a net event a modified client could reach', () => {
    // §2.9. `onNet` would hand any player a one-argument purge of anybody else's phone
    // across twenty-two tables. This is the assertion that catches the slip.
    expect(localHandlers.has(CHARACTER_DELETED_EVENT)).toBe(true);
    expect(netHandlers.has(CHARACTER_DELETED_EVENT)).toBe(false);
  });

  it('purges when told a character is gone', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    localHandlers.get(CHARACTER_DELETED_EVENT)![0]('CID_Z');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deletes().length).toBe(ownedTables().length);
    expect(dbMock.query.mock.calls.at(-1)![1]).toEqual(['CID_Z']);
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
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(logged.some((line) => /orphan sweep starting over \d+ table\(s\)/.test(line))).toBe(
        true
      );
      expect(logged.some((line) => /orphan sweep finished: removed 0 row\(s\)/.test(line))).toBe(
        true
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the older media-only hook registered and media-only', async () => {
    // Renaming it would silently switch off cleanup for every owner already wired to it,
    // and widening it would delete more than the caller asked for. It stays as documented.
    expect(localHandlers.has('mica:server:media:characterDeleted')).toBe(true);

    dbMock.query.mockResolvedValue({ affectedRows: 1 });
    localHandlers.get('mica:server:media:characterDeleted')![0]('CID_Z');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deletes()).toEqual(['DELETE FROM mica_media WHERE citizenid = ?']);
  });
});
