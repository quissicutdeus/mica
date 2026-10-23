// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0012_blabber_mouths_unique_while_live';
import { blabber } from '../services/Blabber';

/**
 * MICA-330's migration, as text: the guards, the order (the new key before the old one goes, so
 * the table is never without one), and that the expression it restates is the one the
 * declaration has.
 */

/** What `information_schema` answers: which table, column and keys exist. */
let schema: { table: boolean; mouthKey: boolean; key: boolean; oldKey: boolean };

const statements = () => dbMock.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  schema = { table: true, mouthKey: false, key: false, oldKey: true };
  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('information_schema.TABLES')) return schema.table ? 1 : 0;
    if (sql.includes('information_schema.COLUMNS')) {
      expect(params).toEqual(['mica_blabber', 'mouth_key']);
      return schema.mouthKey ? 1 : 0;
    }
    if (sql.includes('information_schema.STATISTICS')) {
      if (params[1] === 'account_mouth_key') return schema.key ? 1 : 0;
      if (params[1] === 'account_mouth') return schema.oldKey ? 1 : 0;
    }
    throw new Error(`unexpected scalar: ${sql} ${JSON.stringify(params)}`);
  });
  dbMock.query.mockResolvedValue([]);
});

describe('0012_blabber_mouths_unique_while_live', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0012_blabber_mouths_unique_while_live');
  });

  it('adds the column, adds the new key, then drops the old one — in that order', async () => {
    await migration.up();
    expect(statements()).toEqual([
      'ALTER TABLE `mica_blabber` ADD COLUMN `mouth_key` int(11) GENERATED ALWAYS AS ' +
        "(CASE WHEN `status` <> 'deleted' THEN `mouth_of` ELSE NULL END) VIRTUAL",
      'ALTER TABLE `mica_blabber` ADD UNIQUE KEY `account_mouth_key` (`account_id`, `mouth_key`)',
      'ALTER TABLE `mica_blabber` DROP KEY `account_mouth`'
    ]);
  });

  it('does nothing a second time', async () => {
    schema = { table: true, mouthKey: true, key: true, oldKey: false };
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('finishes a run that stopped after adding the column', async () => {
    schema.mouthKey = true;
    await migration.up();
    expect(statements()).toEqual([
      'ALTER TABLE `mica_blabber` ADD UNIQUE KEY `account_mouth_key` (`account_id`, `mouth_key`)',
      'ALTER TABLE `mica_blabber` DROP KEY `account_mouth`'
    ]);
  });

  it('finishes a run that stopped before dropping the old key', async () => {
    schema = { table: true, mouthKey: true, key: true, oldKey: true };
    await migration.up();
    expect(statements()).toEqual(['ALTER TABLE `mica_blabber` DROP KEY `account_mouth`']);
  });

  it('never drops the old key when adding the new one failed', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('ADD UNIQUE KEY')) {
        throw new Error("Duplicate entry '1-9' for key 'account_mouth_key'");
      }
      return [];
    });
    await expect(migration.up()).rejects.toThrow(/Duplicate entry/);
    expect(statements().some((sql) => sql.includes('DROP KEY'))).toBe(false);
  });

  it('skips a table this server never created', async () => {
    schema.table = false;
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  /**
   * 0012 is frozen as it shipped, over "not deleted"; MICA-428's 0015 narrowed the key to
   * "active or moderated" and restates today's declaration (`migration0015HiddenRows.test.ts`).
   */
  it('restates the expression as it shipped, and the key the declaration still has', () => {
    const source = readFileSync(
      join(__dirname, '..', 'migrations', '0012_blabber_mouths_unique_while_live.ts'),
      'utf8'
    ).replace(/['"\s+]+/g, '');
    expect(source).toContain(
      "`mouth_key`int(11)GENERATEDALWAYSAS(CASEWHEN`status`<>'deleted'THEN`mouth_of`ELSENULLEND)VIRTUAL".replace(
        /'/g,
        ''
      )
    );
    expect(blabber.resolved.indexes).toContainEqual(
      expect.objectContaining({ name: 'account_mouth_key', columns: ['account_id', 'mouth_key'] })
    );
  });
});
