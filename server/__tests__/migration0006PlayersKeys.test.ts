// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0006_players_foreign_keys_dropped';

/**
 * MICA-300's migration, as text. `pnpm test:migrations` runs it against a real MariaDB on a qb
 * database created before it, twice; this pins how the keys are found and what is dropped.
 */
const isLookup = (sql: string) => sql.includes('information_schema.REFERENTIAL_CONSTRAINTS');
const drops = (): string[] =>
  dbMock.query.mock.calls.map((c: any[]) => String(c[0])).filter((sql) => !isLookup(sql));

const withKeys = (keys: { table: unknown; name: unknown }[] | unknown) => {
  dbMock.query.mockImplementation(async (sql: string) => (isLookup(sql) ? keys : []));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('0006_players_foreign_keys_dropped', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0006_players_foreign_keys_dropped');
  });

  it('finds the keys by what they reference, on micaOS tables only, never by name', async () => {
    withKeys([]);
    await migration.up();

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('CONSTRAINT_SCHEMA = DATABASE()');
    expect(String(sql)).toContain('REFERENCED_TABLE_NAME = ?');
    // The underscore escaped, so `micaX` is not a match.
    expect(String(sql)).toContain("TABLE_NAME LIKE 'mica\\_%'");
    expect(params).toEqual(['players']);
  });

  it('drops each one it finds, whatever it is called', async () => {
    withKeys([
      { table: 'mica_audit_logs', name: 'fk_audit_logs_citizenid' },
      { table: 'mica_notes', name: 'fk_notes_citizenid' },
      { table: 'mica_blabber_attachments', name: 'restored_by_hand_1' }
    ]);
    await migration.up();

    expect(drops()).toEqual([
      'ALTER TABLE `mica_audit_logs` DROP FOREIGN KEY `fk_audit_logs_citizenid`',
      'ALTER TABLE `mica_notes` DROP FOREIGN KEY `fk_notes_citizenid`',
      'ALTER TABLE `mica_blabber_attachments` DROP FOREIGN KEY `restored_by_hand_1`'
    ]);
  });

  it('does nothing where there are none: ESX, standalone, or a second run', async () => {
    withKeys([]);
    await migration.up();
    expect(drops()).toEqual([]);
  });

  it('refuses a name it would have to quote, before dropping anything', async () => {
    withKeys([
      { table: 'mica_notes', name: 'fk_notes_citizenid' },
      { table: 'mica_notes', name: 'x` ; DROP TABLE players; --' }
    ]);
    await expect(migration.up()).rejects.toThrow(/not a plain name/);
    expect(drops()).toEqual([]);
  });

  it('fails rather than reading an answer it does not understand as "none"', async () => {
    withKeys({ affectedRows: 0 });
    await expect(migration.up()).rejects.toThrow(/did not answer/);
    expect(drops()).toEqual([]);
  });
});
