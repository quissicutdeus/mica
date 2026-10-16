// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0011_media_records_its_size';
import { media } from '../services/Media';
import { toSqlFile } from '../lib/schemaSql';

/**
 * MICA-358's migration, as text: the guards, the column it adds matching the declaration, and
 * the backfill's shape. What MariaDB does with it — that it runs, sizes the rows it says it
 * sizes, and leaves the table the planner expects — was run on a throwaway MariaDB for the
 * ticket; this pins what the statements say.
 */

let schema: { table: boolean; column: boolean };
let bounds: { low: number | null; high: number | null } | null;

const statements = () => dbMock.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  schema = { table: true, column: false };
  bounds = { low: 1, high: 2500 };
  dbMock.scalar.mockImplementation(async (sql: string) => {
    if (sql.includes('information_schema.TABLES')) return schema.table ? 1 : 0;
    if (sql.includes('information_schema.COLUMNS')) return schema.column ? 1 : 0;
    throw new Error(`unexpected scalar: ${sql}`);
  });
  dbMock.single.mockImplementation(async () => bounds);
  dbMock.query.mockResolvedValue([]);
});

describe('0011_media_records_its_size', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0011_media_records_its_size');
  });

  it('adds the column exactly as the declaration renders it', async () => {
    await migration.up();

    const [alter] = statements();
    const declared = toSqlFile(media.resolved)
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .find((line) => line.startsWith('`stored_bytes`'));
    expect(declared).toBe('`stored_bytes` int(11) DEFAULT NULL');
    expect(alter).toBe(`ALTER TABLE \`mica_media\` ADD COLUMN ${declared}`);
  });

  it('backfills every id in ranges of 1000, each row only once and only without a url', async () => {
    await migration.up();

    const updates = dbMock.query.mock.calls.slice(1);
    expect(updates.map(([, params]) => params)).toEqual([
      [1, 1000],
      [1001, 2000],
      [2001, 2500]
    ]);
    const sql = statements()[1];
    expect(sql).toContain(
      'SET `stored_bytes` = IFNULL(LENGTH(`data`), 0) + IFNULL(LENGTH(`thumbnail`), 0)'
    );
    expect(sql).toContain('WHERE `id` BETWEEN ? AND ?');
    expect(sql).toContain('AND `stored_bytes` IS NULL');
    expect(sql).toContain("AND (`url` IS NULL OR `url` = '')");
  });

  it('pins updated_at, so no restore window reopens', async () => {
    await migration.up();
    expect(statements()[1]).toContain('`updated_at` = `updated_at`');
  });

  it('does not add the column twice, and still finishes a backfill a failed run left', async () => {
    schema.column = true;
    await migration.up();

    const run = statements();
    expect(run.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false);
    expect(run).toHaveLength(3);
  });

  it('sizes nothing on an empty table', async () => {
    bounds = { low: null, high: null };
    await migration.up();
    expect(statements()).toHaveLength(1);
  });

  it('does nothing on a server that never had the table', async () => {
    schema.table = false;
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});
