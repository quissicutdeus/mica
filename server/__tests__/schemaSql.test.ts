import { describe, it, expect } from 'vitest';
import {
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

describe('schemaMigrationsSeedSql', () => {
  it('returns null for an empty id list', () => {
    expect(schemaMigrationsSeedSql([])).toBeNull();
  });

  it('emits one INSERT IGNORE with every id', () => {
    const sql = schemaMigrationsSeedSql(['0001_rename_photos_to_media', '0002_widen_status']);
    expect(sql).toBe(
      `INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES\n` +
        "  ('0001_rename_photos_to_media'),\n" +
        "  ('0002_widen_status');"
    );
  });

  it('escapes a single quote in an id', () => {
    const sql = schemaMigrationsSeedSql(["weird'id"]);
    expect(sql).toContain("weird''id");
  });
});
