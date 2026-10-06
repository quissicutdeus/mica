// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import '../services/index';
import { setOwnerTableResolver } from '../lib/ownerWidth';
import {
  AUTO_SCHEMA_CONVAR,
  driverErrno,
  runSchemaBootstrap,
  __setSchemaSleepForTests
} from '../lib/schemaBootstrap';
import {
  schemaCheckInstalled,
  schemaReady,
  whenSchemaReady,
  __setSchemaReadyForTests,
  type SchemaOutcome
} from '../lib/schemaReady';
import { bootstrapTables, createStatements, SCHEMA_MIGRATIONS_TABLE } from '../lib/schemaSql';
import { AUDIT_LOG_TABLE } from '../lib/AuditLogger';
import { migrations } from '../migrations';

/**
 * The first-start bootstrap (MICA-306), against a fake database that answers the way oxmysql
 * does: a failed query rejects with "<resource> was unable to execute a query!", the query, and
 * the driver's message on the last line — no errno. These assert what is sent and what is
 * decided; only `test:schema` proves MariaDB accepts the statements.
 */

interface FakeDb {
  tables: Set<string>;
  ledgerRows: number;
  players: boolean;
  probeError: Error | null;
  /** Fail the CREATE of this table (or the seed, as 'seed') with this driver message. */
  failOn: { table: string; message: string } | null;
  statements: string[];
  seed: string | null;
}

const db: FakeDb = {
  tables: new Set(),
  ledgerRows: 0,
  players: true,
  probeError: null,
  failOn: null,
  statements: [],
  seed: null
};

/** An oxmysql `*_async` rejection: the whole query in the text, the driver's line last. */
const oxmysqlError = (sql: string, message: string): Error =>
  new Error(`mica was unable to execute a query!\nQuery: ${sql}\n[]\n${message}`);

const createdTable = (sql: string): string | null =>
  sql.match(/^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`/)?.[1] ?? null;

const fakeQuery = async (sql: string): Promise<unknown> => {
  if (sql.includes('information_schema.TABLES') && sql.includes('AS `name`')) {
    return [...db.tables].map((name) => ({ name }));
  }
  if (sql === 'SELECT 1 FROM `players` LIMIT 0') {
    if (!db.players) throw oxmysqlError(sql, "Table 'mica.players' doesn't exist");
    return [];
  }
  const table = createdTable(sql);
  if (table) {
    db.statements.push(sql);
    if (db.failOn?.table === table) throw oxmysqlError(sql, db.failOn.message);
    if (db.tables.has(table)) throw oxmysqlError(sql, `Table '${table}' already exists`);
    db.tables.add(table);
    return { affectedRows: 0 };
  }
  if (sql.startsWith(`INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\``)) {
    db.statements.push(sql);
    if (db.failOn?.table === 'seed') throw oxmysqlError(sql, db.failOn.message);
    db.seed = sql;
    db.ledgerRows = [...sql.matchAll(/\('([^']+)'\)/g)].length;
    return { affectedRows: db.ledgerRows };
  }
  throw new Error(`unexpected query(): ${sql}`);
};

const fakeScalar = async (sql: string): Promise<unknown> => {
  if (sql.includes('COUNT(*) = 0 FROM information_schema.TABLES')) {
    if (db.probeError) throw db.probeError;
    return [...db.tables].some((t) => t.startsWith('mica_')) ? 0 : 1;
  }
  if (sql === `SELECT COUNT(*) FROM \`${SCHEMA_MIGRATIONS_TABLE}\``) return db.ledgerRows;
  throw new Error(`unexpected scalar(): ${sql}`);
};

let owner: boolean | null = true;
let sleeps = 0;
let onSleep: (() => void) | null = null;
let convars: Record<string, string> = {};
const realGetConvar = (globalThis as any).GetConvar;

const errors = (): string[] =>
  (console.error as any).mock.calls.map((c: unknown[]) => String(c[0]));
const logs = (): string[] => (console.log as any).mock.calls.map((c: unknown[]) => String(c[0]));
const creates = (): string[] => db.statements.filter((sql) => sql.startsWith('CREATE TABLE'));
const ALL_TABLES = (): string[] => bootstrapTables();

beforeEach(() => {
  db.tables = new Set();
  db.ledgerRows = 0;
  db.players = true;
  db.probeError = null;
  db.failOn = null;
  db.statements = [];
  db.seed = null;
  owner = true;
  sleeps = 0;
  onSleep = null;
  convars = {};
  dbMock.query.mockReset().mockImplementation(fakeQuery);
  dbMock.scalar.mockReset().mockImplementation(fakeScalar);
  setOwnerTableResolver(() => owner);
  __setSchemaSleepForTests(async () => {
    sleeps++;
    onSleep?.();
  });
  __setSchemaReadyForTests(null);
  (globalThis as any).GetConvar = (name: string, fallback: string) => convars[name] ?? fallback;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setSchemaSleepForTests(null);
  __setSchemaReadyForTests(null);
  (globalThis as any).GetConvar = realGetConvar;
  vi.restoreAllMocks();
});

const refusal = (outcome: SchemaOutcome) => {
  expect(outcome.kind).toBe('refused');
  return outcome as Extract<SchemaOutcome, { kind: 'refused' }>;
};

describe('a database that already has micaOS tables', () => {
  it('is left exactly as it is', async () => {
    db.tables = new Set(['mica_notes', 'mica_contacts']);

    await expect(runSchemaBootstrap()).resolves.toEqual({ kind: 'existing' });
    expect(db.statements).toEqual([]);
    expect(sleeps).toBe(0);
  });

  it('is left as it is with a seeded ledger, even when a declared table is missing', async () => {
    db.tables = new Set([SCHEMA_MIGRATIONS_TABLE, 'mica_notes']);
    db.ledgerRows = 3;

    await expect(runSchemaBootstrap()).resolves.toEqual({ kind: 'existing' });
    expect(db.statements).toEqual([]);
  });

  it('is left as it is when the ledger is empty but every table is there', async () => {
    db.tables = new Set(ALL_TABLES());

    await expect(runSchemaBootstrap()).resolves.toEqual({ kind: 'existing' });
    expect(db.statements).toEqual([]);
    expect(errors()).toEqual([]);
  });

  /**
   * An empty ledger beside a missing table is what a first start that stopped part-way leaves —
   * and also an existing install that re-imported mica.sql over an older database (MICA-301:
   * ledger created, nothing recorded) and then took an update that added a table. Refusing would
   * stop that live server's start-up jobs on every boot, so it is said, never refused or resumed.
   */
  it('says an existing database may be half-created, and lets start-up run as before', async () => {
    // Every table but the newest, beside the ledger a re-import created and left empty.
    const added = ALL_TABLES().at(-1)!;
    db.tables = new Set(ALL_TABLES().filter((table) => table !== added));
    db.ledgerRows = 0;

    const outcome = await runSchemaBootstrap();

    expect(outcome).toEqual({ kind: 'existing' });
    const said = errors().filter((line) => line.includes('may be half-created'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`1 table(s) micaOS needs are missing (${added})`);
    expect(said[0]).toContain('import mica.sql');
    expect(said[0]).toContain("run 'micaschema apply'");
    expect(db.statements).toEqual([]);
  });
});

describe('a fresh database', () => {
  it('on qb: reads players, creates every table, seeds the ledger, and says so once', async () => {
    const outcome = await runSchemaBootstrap();

    expect(outcome).toEqual({ kind: 'created', shape: 'qb', tables: ALL_TABLES().length });
    expect(dbMock.query).toHaveBeenCalledWith('SELECT 1 FROM `players` LIMIT 0', []);
    expect(db.statements).toEqual(createStatements(true));
    expect([...db.tables].toSorted()).toEqual(ALL_TABLES().toSorted());
    // Plain CREATE throughout: a table that is unexpectedly there stops it.
    expect(creates().every((sql) => !sql.includes('IF NOT EXISTS'))).toBe(true);
    expect(creates().find((sql) => createdTable(sql) === AUDIT_LOG_TABLE)).toContain(
      '`citizenid` varchar(50) NOT NULL'
    );
    const success = logs().filter((line) => line.startsWith("[mica] created micaOS's schema"));
    expect(success).toEqual([
      `[mica] created micaOS's schema for qbx/qb (citizenid 50 wide): ` +
        `${ALL_TABLES().length} tables, ${migrations.length} migration(s) recorded as applied.`
    ]);
  });

  it('on ESX or standalone: never asks for players, and sizes citizenid 60', async () => {
    owner = false;

    const outcome = await runSchemaBootstrap();

    expect(outcome).toEqual({ kind: 'created', shape: 'esx', tables: ALL_TABLES().length });
    expect(dbMock.query.mock.calls.some(([sql]) => String(sql).includes('`players`'))).toBe(false);
    expect(db.statements).toEqual(createStatements(false));
    expect(creates().find((sql) => createdTable(sql) === AUDIT_LOG_TABLE)).toContain(
      '`citizenid` varchar(60) NOT NULL'
    );
    expect(creates().some((sql) => sql.includes('`citizenid` varchar(50)'))).toBe(false);
  });

  it('creates the ledger first, then the audit log, and seeds last', async () => {
    await runSchemaBootstrap();

    expect(createdTable(db.statements[0])).toBe(SCHEMA_MIGRATIONS_TABLE);
    expect(createdTable(db.statements[1])).toBe(AUDIT_LOG_TABLE);
    expect(db.statements.at(-1)).toBe(db.seed);
    expect(db.statements.slice(0, -1).map(createdTable)).toEqual(ALL_TABLES());
  });

  it("seeds exactly the barrel's migration ids, so apply finds nothing pending", async () => {
    await runSchemaBootstrap();

    const seeded = [...(db.seed ?? '').matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
    expect(seeded).toEqual(migrations.map((m) => m.id).toSorted());
    expect(seeded.length).toBeGreaterThan(0);
  });

  it('waits for a framework that has not started yet, then creates', async () => {
    owner = null;
    onSleep = () => {
      if (sleeps === 3) owner = false;
    };

    const outcome = await runSchemaBootstrap();

    expect(outcome).toMatchObject({ kind: 'created', shape: 'esx' });
    expect(sleeps).toBe(3);
  });

  it('refuses after about a minute when no framework answers, creating nothing', async () => {
    owner = null;

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('framework-unknown');
    expect(sleeps).toBe(60);
    expect(outcome.message).toContain('no framework answered within 60s');
    expect(outcome.message).toContain('created nothing');
    expect(db.statements).toEqual([]);
  });

  it(`refuses with ${AUTO_SCHEMA_CONVAR} off, naming the file to import`, async () => {
    convars[AUTO_SCHEMA_CONVAR] = '0';

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('disabled');
    expect(outcome.message).toContain('Import mica.sql into it');
    expect(errors()).toContain(outcome.message);
    expect(db.statements).toEqual([]);
    expect(sleeps).toBe(0);
  });

  it(`reads an unrecognised ${AUTO_SCHEMA_CONVAR} as off, and says so`, async () => {
    convars[AUTO_SCHEMA_CONVAR] = 'maybe';
    owner = false;

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('disabled');
    expect(outcome.message).toContain('Import mica.esx.sql');
    expect(
      (console.warn as any).mock.calls.some((c: unknown[]) => /maybe/.test(String(c[0])))
    ).toBe(true);
  });

  it('refuses on qb when players cannot be read, creating nothing', async () => {
    db.players = false;

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('owner-table-missing');
    expect(outcome.message).toContain("Table 'mica.players' doesn't exist");
    expect(creates()).toEqual([]);
  });

  /**
   * Two servers on one fresh database both find it empty. The plain CREATE of the ledger is the
   * claim: the loser gets errno 1050 before creating anything, and waits for the winner's seed.
   */
  it('on errno 1050 for the ledger, waits for the other server, then uses its schema', async () => {
    db.tables = new Set();
    db.failOn = {
      table: SCHEMA_MIGRATIONS_TABLE,
      message: `Table '${SCHEMA_MIGRATIONS_TABLE}' already exists`
    };
    onSleep = () => {
      if (sleeps === 2) {
        db.tables = new Set(ALL_TABLES());
        db.ledgerRows = migrations.length;
      }
    };

    await expect(runSchemaBootstrap()).resolves.toEqual({ kind: 'created-elsewhere' });
    expect(creates()).toHaveLength(1);
    expect(db.seed).toBeNull();
  });

  it('on errno 1050, refuses when the seed never appears', async () => {
    db.failOn = {
      table: SCHEMA_MIGRATIONS_TABLE,
      message: `Table '${SCHEMA_MIGRATIONS_TABLE}' already exists`
    };

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('concurrent-create');
    expect(sleeps).toBe(60);
    expect(outcome.message).toContain('another server is creating');
    expect(outcome.message).toContain('import mica.sql');
    expect(creates()).toHaveLength(1);
  });

  it('on errno 1142, says the user lacks DDL rights and how to fix it', async () => {
    db.failOn = {
      table: SCHEMA_MIGRATIONS_TABLE,
      message:
        "CREATE command denied to user 'mica'@'localhost' for table `mica`.`mica_schema_migrations`"
    };

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('no-ddl-rights');
    expect(outcome.message).toContain('Grant it CREATE, INDEX and REFERENCES');
    expect(outcome.message).toContain(`set '${AUTO_SCHEMA_CONVAR} 0'`);
    expect(outcome.message).toContain('Nothing was created.');
    expect(db.seed).toBeNull();
  });

  it('stops at the first failure mid-create, logs the table and N/M, and never seeds', async () => {
    const tables = ALL_TABLES();
    const failing = tables[4];
    db.failOn = { table: failing, message: "Can't create table (errno: 150)" };
    const total = createStatements(true).length;

    const outcome = refusal(await runSchemaBootstrap());

    expect(outcome.reason).toBe('create-failed');
    expect(creates().map(createdTable)).toEqual(tables.slice(0, 5));
    expect(db.seed).toBeNull();
    expect(db.statements.some((sql) => sql.startsWith('INSERT'))).toBe(false);
    expect(errors()).toContain(
      `[mica] creating ${failing} failed (statement 5 of ${total}): ` +
        "Can't create table (errno: 150). Stopped there; the migrations ledger was not seeded."
    );
    expect(outcome.message).toContain('now half-created');
    expect(outcome.message).toContain('import mica.sql');

    // And the next start, no longer on a fresh database, says what it left and never resumes it.
    db.failOn = null;
    db.statements = [];
    (console.error as any).mockClear();
    await expect(runSchemaBootstrap()).resolves.toEqual({ kind: 'existing' });
    expect(errors().some((line) => line.includes('may be half-created'))).toBe(true);
    expect(db.statements).toEqual([]);
  });
});

describe('a database the probe cannot read', () => {
  it('creates nothing, and never calls it empty', async () => {
    db.probeError = oxmysqlError('SELECT …', "Access denied for user 'mica'@'localhost'");

    const outcome = await runSchemaBootstrap();

    expect(outcome).toEqual({
      kind: 'unknown',
      error: "Access denied for user 'mica'@'localhost'"
    });
    expect(db.statements).toEqual([]);
    expect(errors().join('\n')).toContain('could not tell whether');
    expect(errors().join('\n')).not.toMatch(/holds no micaOS table/);
  });
});

describe('the gate', () => {
  it('is installed by the services graph, so schemaReady never runs without it', () => {
    expect(schemaCheckInstalled()).toBe(true);
  });

  it('runs the check once, however many jobs wait on it', async () => {
    db.tables = new Set(['mica_notes']);

    const [a, b] = await Promise.all([schemaReady(), schemaReady()]);

    expect(a).toEqual({ kind: 'existing' });
    expect(b).toBe(a);
    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
  });

  it('runs a start-up job only after every table exists', async () => {
    let tablesWhenRun = -1;
    whenSchemaReady(() => {
      tablesWhenRun = db.tables.size;
    });

    await vi.waitFor(() => expect(tablesWhenRun).toBe(ALL_TABLES().length));
  });

  it('holds start-up jobs back when the check refused, and runs them on every other outcome', async () => {
    const ran: string[] = [];
    const outcomes: SchemaOutcome[] = [
      { kind: 'refused', reason: 'disabled', message: 'x' },
      { kind: 'existing' },
      { kind: 'created', shape: 'qb', tables: 1 },
      { kind: 'created-elsewhere' },
      { kind: 'unknown', error: 'x' }
    ];
    for (const outcome of outcomes) {
      __setSchemaReadyForTests(outcome);
      whenSchemaReady(() => ran.push(outcome.kind));
      await schemaReady();
      await Promise.resolve();
    }

    await vi.waitFor(() =>
      expect(ran).toEqual(['existing', 'created', 'created-elsewhere', 'unknown'])
    );
  });
});

describe('driverErrno', () => {
  it('reads errno where mysql2 carries it, and the message where oxmysql carries only text', () => {
    expect(driverErrno(Object.assign(new Error('x'), { errno: 1142 }))).toBe(1142);
    expect(driverErrno(Object.assign(new Error('x'), { code: 'ER_TABLE_EXISTS_ERROR' }))).toBe(
      1050
    );
    expect(driverErrno(oxmysqlError('CREATE TABLE `t` (…)', "Table 't' already exists"))).toBe(
      1050
    );
    expect(
      driverErrno(oxmysqlError('CREATE TABLE `t`', "INDEX command denied to user 'u'@'h'"))
    ).toBe(1142);
    expect(driverErrno(new Error("Can't create table (errno: 150)"))).toBeNull();
  });

  it('classifies by the driver line only, never by the query text above it', () => {
    // A query that happens to contain the words must not read as the error.
    const sql = "SELECT 'already exists' AS `note`";
    expect(driverErrno(oxmysqlError(sql, 'Lock wait timeout exceeded'))).toBeNull();
  });
});
