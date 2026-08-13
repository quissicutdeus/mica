const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../migrations', () => ({
  migrations: [
    { id: '0001_a', description: 'first', up: vi.fn(async () => {}) },
    { id: '0002_b', description: 'second', up: vi.fn(async () => {}) }
  ]
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
