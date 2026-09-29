// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  freshImportProbeSql,
  SCHEMA_MIGRATIONS_TABLE,
  schemaMigrationsLedgerDdl,
  schemaMigrationsSeedSql
} from '../lib/schemaSql';

describe('schemaMigrationsLedgerDdl', () => {
  it('creates the ledger table with an id primary key and a timestamp', () => {
    const sql = schemaMigrationsLedgerDdl();
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS \`${SCHEMA_MIGRATIONS_TABLE}\``);
    expect(sql).toContain('`id` varchar(255) NOT NULL');
    expect(sql).toContain('PRIMARY KEY (`id`)');
  });
});

describe('freshImportProbeSql', () => {
  it('asks whether any mica_ table exists, with the underscore literal, into the seed variable', () => {
    const sql = freshImportProbeSql();
    expect(sql).toContain(
      'SET @mica_fresh_import = (SELECT COUNT(*) = 0 FROM information_schema.TABLES'
    );
    expect(sql).toContain("table_schema = DATABASE() AND table_name LIKE 'mica|_%' ESCAPE '|'");
  });
});

describe('schemaMigrationsSeedSql', () => {
  it('returns null for an empty id list', () => {
    expect(schemaMigrationsSeedSql([])).toBeNull();
  });

  it('emits one INSERT IGNORE with every id, only for an import that created micaOS (MICA-301)', () => {
    const sql = schemaMigrationsSeedSql(['0001_rename_photos_to_media', '0002_widen_status']);
    expect(sql).toBe(
      `INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`)\n` +
        'SELECT `id` FROM (\n' +
        "    SELECT '0001_rename_photos_to_media' AS `id`\n" +
        "    UNION ALL SELECT '0002_widen_status'\n" +
        ') AS `seed` WHERE @mica_fresh_import = 1;'
    );
  });

  it('escapes a single quote in an id', () => {
    const sql = schemaMigrationsSeedSql(["weird'id"]);
    expect(sql).toContain("weird''id");
  });
});
