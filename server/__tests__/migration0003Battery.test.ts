// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0003_battery_follows_the_phone';

/**
 * MICA-283's migration, as text. `pnpm test:migrations` runs it against a real MariaDB on
 * both framework shapes; this pins the ordering and the guards between runs of that.
 */
const live = (present: Record<string, boolean>) => {
  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/information_schema\.COLUMNS/.test(sql))
      return present[`${params[0]}.${params[1]}`] ? 1 : 0;
    if (/information_schema\.STATISTICS/.test(sql))
      return present[`${params[0]}#${params[1]}`] ? 1 : 0;
    return 0;
  });
};

const ran = () => dbMock.query.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dbMock.query.mockResolvedValue([]);
});

describe('0003_battery_follows_the_phone', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0003_battery_follows_the_phone');
  });

  it('adds the column and key, mints, backfills, then swaps the unique key — add before drop', async () => {
    live({ 'mica_battery#citizenid_unique': true });
    dbMock.query.mockImplementation(async (sql: string) =>
      /SELECT DISTINCT/.test(sql) ? [{ citizenid: 'CIT_B' }] : []
    );

    await migration.up();

    const statements = ran();
    expect(statements[0]).toContain(
      'ALTER TABLE `mica_battery` ADD COLUMN `phone_id` varchar(32) DEFAULT NULL'
    );
    expect(statements[1]).toContain('ADD KEY `phone_id` (`phone_id`)');
    expect(statements[2]).toMatch(/^SELECT DISTINCT b\.`citizenid` FROM `mica_battery` b/);
    expect(statements[3]).toMatch(
      /^INSERT INTO `mica_phones` \(`citizenid`, `phone_id`, `claimed`\) VALUES \(\?, \?, 0\)/
    );
    expect(dbMock.query.mock.calls[3][1][1]).toMatch(/^[0-9a-f]{32}$/);
    expect(statements[4]).toMatch(/^UPDATE `mica_battery` t JOIN/);
    expect(statements[4]).toContain('WHERE t.`phone_id` IS NULL');
    expect(statements[5]).toContain('ADD UNIQUE KEY `phone_id_unique` (`phone_id`)');
    expect(statements[6]).toContain('DROP KEY `citizenid_unique`');
  });

  it('is safe to run twice: guarded DDL, no mint for a citizen with a phone', async () => {
    live({
      'mica_battery.phone_id': true,
      'mica_battery#phone_id': true,
      'mica_battery#phone_id_unique': true
    });

    await migration.up();

    const statements = ran();
    expect(statements.filter((s) => s.startsWith('ALTER'))).toEqual([]);
    expect(statements.filter((s) => s.startsWith('INSERT'))).toEqual([]);
    // The backfill still runs; it only ever touches rows still holding NULL.
    expect(statements.filter((s) => s.startsWith('UPDATE'))).toHaveLength(1);
  });
});
