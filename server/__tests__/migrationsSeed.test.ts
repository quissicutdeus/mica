// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MICA_SQL = path.join(__dirname, '..', '..', 'mica.sql');
const MICA_ESX_SQL = path.join(__dirname, '..', '..', 'mica.esx.sql');

/** The seed statement of a generated file: from the INSERT to its closing semicolon. */
const seedOf = (sql: string): string => {
  const start = sql.indexOf('INSERT IGNORE INTO `mica_schema_migrations`');
  return start === -1 ? '' : sql.slice(start, sql.indexOf(';', start) + 1);
};

const migrationIdsOnDisk = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .toSorted();

describe('the migrations ledger seed stays in sync with server/migrations/', () => {
  it('lists every migration id in the generated mica.sql seed', () => {
    const ids = migrationIdsOnDisk();
    // Nothing to check yet: no breaking schema change has needed one (AGENTS.md §8).
    if (ids.length === 0) return;

    for (const file of [MICA_SQL, MICA_ESX_SQL]) {
      const seed = seedOf(fs.readFileSync(file, 'utf8'));
      for (const id of ids)
        expect(seed, `${path.basename(file)}: ${id}`).toContain(`SELECT '${id}'`);
    }
  });

  /**
   * MICA-301. Every table is `CREATE TABLE IF NOT EXISTS`, so a file re-imported over an
   * existing database leaves its tables as they were; seeding the ledger there marked every
   * migration applied without running one. Each file asks whether any micaOS table exists
   * before it creates one, and seeds only when none did.
   */
  it.each([
    ['mica.sql', MICA_SQL],
    ['mica.esx.sql', MICA_ESX_SQL]
  ])('%s seeds the ledger only when the import found no micaOS table', (_name, file) => {
    const sql = fs.readFileSync(file, 'utf8');
    const probe = sql.indexOf('SET @mica_fresh_import = (SELECT COUNT(*) = 0');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(sql.indexOf('\nCREATE TABLE IF NOT EXISTS'));
    expect(sql.slice(probe, sql.indexOf(';', probe))).toContain(
      "table_name LIKE 'mica|_%' ESCAPE '|'"
    );
    expect(seedOf(sql).endsWith('WHERE @mica_fresh_import = 1;')).toBe(true);
    // One seed, and no other statement writes the ledger.
    expect(sql.split('INTO `mica_schema_migrations`')).toHaveLength(2);
  });

  it('every migration file exports an id matching its own filename', async () => {
    const ids = migrationIdsOnDisk();
    for (const id of ids) {
      const mod = await import(path.join(MIGRATIONS_DIR, `${id}.ts`));
      expect(mod.migration?.id).toBe(id);
    }
  });
});
