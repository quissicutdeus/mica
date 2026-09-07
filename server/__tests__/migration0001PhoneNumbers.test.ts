// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0001_phone_numbers_follow_the_phone';

/**
 * MICA-284's migration, as text.
 *
 * Everything here is an assertion about which statements run and in what order, against a
 * mocked `Database`. It is blind to everything MariaDB decides — whether the `ALTER` parses,
 * whether `INSERT IGNORE ... SELECT` seeds the rows really present, whether the dropped key
 * was the one holding the wedge. `pnpm test:migrations` runs this same module against a real
 * server on both framework shapes, and is the half that proves it; this half is what keeps
 * the ordering and the guards from regressing between runs of that.
 */

/** What `information_schema` answers for each probe, keyed on the identifier asked about. */
const live = (present: Record<string, boolean>) => {
  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/information_schema\.COLUMNS/.test(sql)) {
      const [table, column] = params as string[];
      return present[`${table}.${column}`] ? 1 : 0;
    }
    if (/information_schema\.STATISTICS/.test(sql)) {
      const [table, index] = params as string[];
      return present[`${table}#${index}`] ? 1 : 0;
    }
    // Row counts, for the seed's report.
    return 0;
  });
};

const ran = () => dbMock.query.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dbMock.query.mockResolvedValue([]);
});

describe('0001_phone_numbers_follow_the_phone', () => {
  it('is named for its file, so the ledger and the barrel agree', () => {
    expect(migration.id).toBe('0001_phone_numbers_follow_the_phone');
  });

  it('adds the column and its key, seeds from charinfo, and drops citizenid_unique last', async () => {
    live({
      'mica_phone_numbers#citizenid_unique': true,
      'players.charinfo': true
    });

    await migration.up();

    const statements = ran();
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain('ADD COLUMN `phone_id` varchar(32) DEFAULT NULL');
    expect(statements[1]).toContain('ADD UNIQUE KEY `phone_id_unique` (`phone_id`)');
    expect(statements[2]).toMatch(
      /^INSERT IGNORE INTO `mica_phone_numbers` \(`citizenid`, `number`\)/
    );
    expect(statements[3]).toContain('DROP KEY `citizenid_unique`');
  });

  it("seeds only a valid, non-empty phone that fits the column, out of qb's charinfo JSON", () => {
    live({ 'players.charinfo': true });

    return migration.up().then(() => {
      const seed = ran().find((sql) => sql.startsWith('INSERT IGNORE'))!;
      expect(seed).toContain("JSON_UNQUOTE(JSON_EXTRACT(`charinfo`, '$.phone'))");
      expect(seed).toContain('JSON_VALID(`charinfo`)');
      expect(seed).toContain("`phone` <> ''");
      expect(seed).toContain("`phone` <> 'null'");
      expect(seed).toContain('CHAR_LENGTH(`phone`) <= 16');
      expect(seed).toContain('FROM `players`');
      // A character who already has a row keeps it, so a retry after the drop adds nothing.
      expect(seed).toContain('NOT EXISTS');
    });
  });

  it('seeds while citizenid_unique still stands, so a character never gets two rows', async () => {
    live({ 'mica_phone_numbers#citizenid_unique': true, 'players.charinfo': true });

    await migration.up();

    const statements = ran();
    expect(statements.findIndex((s) => s.startsWith('INSERT IGNORE'))).toBeLessThan(
      statements.findIndex((s) => s.includes('DROP KEY'))
    );
  });

  it('seeds nothing where there is no qb players table, and says which framework that is', async () => {
    // ESX keeps the number on the character; standalone's rows already exist. Neither has a
    // `players.charinfo` to read, and nothing here guesses at `users` or a community table.
    live({ 'mica_phone_numbers#citizenid_unique': true });

    await migration.up();

    expect(ran().some((sql) => sql.startsWith('INSERT'))).toBe(false);
    expect(ran().some((sql) => sql.includes('`users`'))).toBe(false);
    const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(said.some((line) => line.includes('es_extended'))).toBe(true);
  });

  it('is safe to run twice: every DDL step asks information_schema first', async () => {
    live({
      'mica_phone_numbers.phone_id': true,
      'mica_phone_numbers#phone_id_unique': true
      // citizenid_unique already gone, no players table
    });

    await migration.up();

    expect(ran()).toEqual([]);
  });

  it('reports how many numbers it seeded and how many it had to skip', async () => {
    live({ 'players.charinfo': true });
    // Counts, in the order the migration asks: rows before, eligible characters, rows after.
    dbMock.scalar
      .mockResolvedValueOnce(0) // phone_id column
      .mockResolvedValueOnce(0) // phone_id_unique
      .mockResolvedValueOnce(1) // players.charinfo
      .mockResolvedValueOnce(2) // rows before
      .mockResolvedValueOnce(5) // eligible
      .mockResolvedValueOnce(6) // rows after: four seeded, one skipped
      .mockResolvedValueOnce(0); // citizenid_unique

    await migration.up();

    const said = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(said).toContain('seeded 4 legacy numbers');
    expect(said).toContain('1 skipped');
    expect(said).toContain('fresh number');
  });

  it('describes itself in terms an owner can act on', () => {
    expect(migration.description).toContain('mica_phone_numbers');
    expect(migration.description).toContain('phone_id');
    expect(migration.description).toContain('citizenid_unique');
  });
});
