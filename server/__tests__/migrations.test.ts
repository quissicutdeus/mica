/**
 * `onDisk` stands in for `server/migrations/`, and is deliberately a mutable array the tests
 * share rather than a literal inside the factory: the module reads it on every call, so a
 * test that needs the real directory's current state — empty — can splice it and put it back
 * without re-importing anything.
 */
const { dbMock, onDisk } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  onDisk: [
    { id: '0001_a', description: 'first', up: vi.fn(async () => {}) },
    { id: '0002_b', description: 'second', up: vi.fn(async () => {}) }
  ]
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../migrations', () => ({ migrations: onDisk }));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pendingMigrations,
  runMigrations,
  runPendingMigrations,
  reportPendingMigrations,
  type Migration
} from '../lib/migrations';
import { SCHEMA_MIGRATIONS_TABLE } from '../lib/schemaSql';

const fakeMigration = (id: string, up: () => Promise<void> = async () => {}): Migration => ({
  id,
  description: `test migration ${id}`,
  up
});

describe('pendingMigrations', () => {
  it('returns every migration when none are applied', () => {
    const onDisk = [fakeMigration('0002_b'), fakeMigration('0001_a')];
    const result = pendingMigrations(onDisk, new Set());
    expect(result.map((m) => m.id)).toEqual(['0001_a', '0002_b']);
  });

  it('filters out ids already in the ledger', () => {
    const onDisk = [fakeMigration('0001_a'), fakeMigration('0002_b')];
    const result = pendingMigrations(onDisk, new Set(['0001_a']));
    expect(result.map((m) => m.id)).toEqual(['0002_b']);
  });

  it('sorts by id regardless of input order', () => {
    const onDisk = [fakeMigration('0003_c'), fakeMigration('0001_a'), fakeMigration('0002_b')];
    const result = pendingMigrations(onDisk, new Set());
    expect(result.map((m) => m.id)).toEqual(['0001_a', '0002_b', '0003_c']);
  });
});

describe('runMigrations', () => {
  it('runs every pending migration in order and records each one', async () => {
    const order: string[] = [];
    const pending = [
      fakeMigration('0001_a', async () => {
        order.push('up:0001_a');
      }),
      fakeMigration('0002_b', async () => {
        order.push('up:0002_b');
      })
    ];
    const recordApplied = vi.fn(async (id: string) => {
      order.push(`recorded:${id}`);
    });

    const result = await runMigrations(pending, recordApplied);

    expect(order).toEqual(['up:0001_a', 'recorded:0001_a', 'up:0002_b', 'recorded:0002_b']);
    expect(result).toEqual({ applied: ['0001_a', '0002_b'], failed: null, remaining: [] });
  });

  it('stops at the first failure and does not record it as applied', async () => {
    const recordApplied = vi.fn(async () => {});
    const pending = [
      fakeMigration('0001_a'),
      fakeMigration('0002_b', async () => {
        throw new Error('boom');
      }),
      fakeMigration('0003_c')
    ];

    const result = await runMigrations(pending, recordApplied);

    expect(result.applied).toEqual(['0001_a']);
    expect(result.failed).toEqual({ id: '0002_b', error: 'boom' });
    expect(result.remaining).toEqual(['0003_c']);
    expect(recordApplied).toHaveBeenCalledTimes(1);
    expect(recordApplied).toHaveBeenCalledWith('0001_a');
  });

  it('returns an empty result for an empty pending list', async () => {
    const result = await runMigrations([], vi.fn());
    expect(result).toEqual({ applied: [], failed: null, remaining: [] });
  });

  /**
   * A ledger write that fails after `up()` succeeded is the one failure that leaves the
   * database ahead of its own record of itself. It must not reject the whole run — that
   * would lose the list of what already applied — and it must not be reported as if the
   * migration had not happened, because the fix is the opposite one: look before retrying.
   */
  it('reports a ledger write that fails after the migration itself succeeded', async () => {
    const recordApplied = vi.fn(async () => {
      throw new Error('lock wait timeout');
    });
    const pending = [fakeMigration('0001_a'), fakeMigration('0002_b')];

    const result = await runMigrations(pending, recordApplied);

    expect(result.applied).toEqual([]);
    expect(result.failed?.id).toBe('0001_a');
    expect(result.failed?.error).toContain('lock wait timeout');
    expect(result.failed?.error).toContain('running it again is not a no-op');
    expect(result.remaining).toEqual(['0002_b']);
  });

  it('keeps earlier successes when a later migration cannot be recorded', async () => {
    let calls = 0;
    const recordApplied = vi.fn(async () => {
      if (++calls === 2) throw new Error('ledger gone');
    });
    const pending = [fakeMigration('0001_a'), fakeMigration('0002_b'), fakeMigration('0003_c')];

    const result = await runMigrations(pending, recordApplied);

    expect(result.applied).toEqual(['0001_a']);
    expect(result.failed?.id).toBe('0002_b');
    expect(result.remaining).toEqual(['0003_c']);
  });
});

describe('runPendingMigrations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the ledger table before checking it', async () => {
    dbMock.query.mockResolvedValue([]);
    await runPendingMigrations();

    const createCallIndex = dbMock.query.mock.calls.findIndex((call) =>
      String(call[0]).includes('CREATE TABLE')
    );
    const selectCallIndex = dbMock.query.mock.calls.findIndex((call) =>
      String(call[0]).trim().startsWith('SELECT')
    );
    expect(createCallIndex).toBeGreaterThanOrEqual(0);
    expect(selectCallIndex).toBeGreaterThan(createCallIndex);
  });

  it('skips ids already recorded in the ledger', async () => {
    dbMock.query.mockImplementation((sql: string) => {
      if (sql.trim().startsWith('SELECT')) return Promise.resolve([{ id: '0001_a' }]);
      return Promise.resolve([]);
    });

    const result = await runPendingMigrations();

    expect(result.applied).toEqual(['0002_b']);
  });

  it('inserts a ledger row for each migration it applies', async () => {
    dbMock.query.mockImplementation((sql: string) => {
      if (sql.trim().startsWith('SELECT')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await runPendingMigrations();

    expect(dbMock.query).toHaveBeenCalledWith(
      `INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`,
      ['0001_a']
    );
    expect(dbMock.query).toHaveBeenCalledWith(
      `INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`,
      ['0002_b']
    );
  });
});

describe('reportPendingMigrations', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The invariant this whole path exists to keep, and the same one `SchemaMigrator.report()`
   * holds: reporting reads. It used to create the ledger on every boot — real DDL from a
   * function whose docstring promised it never applied anything — which also meant a boot
   * against a database that would not have it (no privilege, oxmysql not up yet) rejected
   * with nothing catching it.
   */
  it('never writes to the database, ledger table included', async () => {
    dbMock.query.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await reportPendingMigrations();

    for (const [sql] of dbMock.query.mock.calls) {
      expect(String(sql)).not.toMatch(/CREATE|INSERT|ALTER|DROP/i);
    }
  });

  it('reads the ledger without creating it first', async () => {
    dbMock.query.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await reportPendingMigrations();

    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(String(dbMock.query.mock.calls[0][0]).trim().startsWith('SELECT')).toBe(true);
  });

  it('does not reject when the ledger does not exist yet', async () => {
    dbMock.query.mockRejectedValue(
      new Error("Table 'gphone.gphone_schema_migrations' doesn't exist")
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(reportPendingMigrations()).resolves.toBeUndefined();

    // Two migrations are mocked onto disk in this suite, so there is something the
    // unreadable ledger could have been hiding — say so, and name the fix.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("run 'gphoneschema apply' from the server console")
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("doesn't exist"));
  });

  it('logs nothing when everything is already applied', async () => {
    dbMock.query.mockImplementation((sql: string) => {
      if (sql.trim().startsWith('SELECT')) {
        return Promise.resolve([{ id: '0001_a' }, { id: '0002_b' }]);
      }
      return Promise.resolve([]);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await reportPendingMigrations();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('lists every pending migration by id and description', async () => {
    dbMock.query.mockImplementation((sql: string) => {
      if (sql.trim().startsWith('SELECT')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await reportPendingMigrations();

    expect(logSpy).toHaveBeenCalledWith('  0001_a: first');
    expect(logSpy).toHaveBeenCalledWith('  0002_b: second');
  });
});

/**
 * Today's `server/migrations/` is genuinely empty, which is the state every install boots in
 * until the first breaking change ships — so it is the state the boot path has to be quiet
 * in. The rest of this file mocks two migrations onto disk, so this one re-imports the module
 * against an empty directory to get there.
 */
describe('reportPendingMigrations with nothing on disk', () => {
  let shelved: typeof onDisk = [];

  beforeEach(() => {
    vi.clearAllMocks();
    shelved = onDisk.splice(0, onDisk.length);
  });
  afterEach(() => {
    onDisk.push(...shelved);
  });

  it('says nothing at all when the ledger does not exist yet', async () => {
    dbMock.query.mockRejectedValue(
      new Error("Table 'gphone.gphone_schema_migrations' doesn't exist")
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(reportPendingMigrations()).resolves.toBeUndefined();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
