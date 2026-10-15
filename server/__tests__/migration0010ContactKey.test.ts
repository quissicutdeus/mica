// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0010_contact_numbers_unique_per_device';
import { contacts } from '../services/Contacts';

/**
 * MICA-335's migration, as text. `pnpm test:migrations` runs it against a real MariaDB on both
 * framework shapes, with duplicates in the table; this pins the guards, the order, and that the
 * expression it restates is the one the declaration has.
 */

/** What `information_schema` answers: which tables, columns and keys exist. */
let schema: { table: boolean; deviceId: boolean; phoneKey: boolean; key: boolean };
/** The ids the settling read answers. */
let beaten: number[];

const statements = () => dbMock.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  schema = { table: true, deviceId: true, phoneKey: false, key: false };
  beaten = [];
  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('information_schema.TABLES')) return schema.table ? 1 : 0;
    if (sql.includes('information_schema.COLUMNS')) {
      return (params[1] === 'device_id' ? schema.deviceId : schema.phoneKey) ? 1 : 0;
    }
    if (sql.includes('information_schema.STATISTICS')) return schema.key ? 1 : 0;
    throw new Error(`unexpected scalar: ${sql}`);
  });
  dbMock.query.mockImplementation(async (sql: string) =>
    String(sql).includes('SELECT DISTINCT') ? beaten.map((id) => ({ id })) : []
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('0010_contact_numbers_unique_per_device', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0010_contact_numbers_unique_per_device');
  });

  it('adds the column, settles the duplicates, then adds the key — in that order', async () => {
    beaten = [4, 9];
    await migration.up();

    const run = statements();
    expect(run).toHaveLength(4);
    expect(run[0]).toBe(
      'ALTER TABLE `mica_contacts` ADD COLUMN `phone_key` varchar(20) GENERATED ALWAYS AS ' +
        "(CASE WHEN `status` = 'active' THEN `phone` ELSE NULL END) VIRTUAL"
    );
    // Joined on the generated column, so it compares exactly as the key will.
    expect(run[1]).toContain('keeper.`phone_key` = loser.`phone_key`');
    expect(run[1]).toContain('keeper.`device_id` = loser.`device_id`');
    expect(run[2]).toBe(
      "UPDATE `mica_contacts` SET `status` = 'deleted', `updated_at` = `updated_at` " +
        "WHERE `status` = 'active' AND `id` IN (?, ?)"
    );
    expect(dbMock.query.mock.calls[2][1]).toEqual([4, 9]);
    expect(run[3]).toBe(
      'ALTER TABLE `mica_contacts` ADD UNIQUE KEY `device_phone_unique` (`device_id`, `phone_key`)'
    );
  });

  it('keeps the favourite, then the last edited, then the newest', async () => {
    await migration.up();
    expect(statements()[1]).toContain(
      '(COALESCE(keeper.`favorite`, 0), keeper.`updated_at`, keeper.`id`) > ' +
        '(COALESCE(loser.`favorite`, 0), loser.`updated_at`, loser.`id`)'
    );
  });

  it('settles a long list in chunks, and names a bounded number of ids', async () => {
    beaten = Array.from({ length: 501 }, (_, i) => i + 1);
    await migration.up();

    const updates = dbMock.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'));
    expect(updates.map(([, params]) => (params as unknown[]).length)).toEqual([500, 1]);
    const line = String(vi.mocked(console.log).mock.calls[0][0]);
    expect(line).toContain('501 live contact(s)');
    expect(line).toContain('and 401 more');
  });

  it('adds the key with nothing to settle, and says nothing', async () => {
    await migration.up();
    expect(statements().some((sql) => sql.startsWith('UPDATE'))).toBe(false);
    expect(statements().at(-1)).toContain('ADD UNIQUE KEY `device_phone_unique`');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('does nothing a second time', async () => {
    schema.phoneKey = true;
    schema.key = true;
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('finishes a run that stopped after adding the column', async () => {
    schema.phoneKey = true;
    await migration.up();
    expect(statements()[0]).toContain('SELECT DISTINCT');
    expect(statements().at(-1)).toContain('ADD UNIQUE KEY');
  });

  it('skips a table this server never imported', async () => {
    schema.table = false;
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a table with no device column, changing nothing', async () => {
    schema.deviceId = false;
    await expect(migration.up()).rejects.toThrow(/no device_id column/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('restates the expression the declaration has today', () => {
    const declared = contacts.resolved.fields.find((f) => f.name === 'phone_key')?.def;
    expect(declared).toMatchObject({
      type: 'string',
      length: 20,
      generatedAs: "CASE WHEN `status` = 'active' THEN `phone` ELSE NULL END"
    });
    expect(contacts.resolved.indexes).toContainEqual(
      expect.objectContaining({ name: 'device_phone_unique', columns: ['device_id', 'phone_key'] })
    );
  });
});
