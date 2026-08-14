import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MICA_SQL = path.join(__dirname, '..', '..', 'gphone.sql');

const migrationIdsOnDisk = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();

describe('the migrations ledger seed stays in sync with server/migrations/', () => {
  it('lists every migration id in the generated gphone.sql seed', () => {
    const ids = migrationIdsOnDisk();
    // Nothing to check yet: no breaking schema change has needed one (AGENTS.md §8).
    if (ids.length === 0) return;

    const sql = fs.readFileSync(MICA_SQL, 'utf8');
    for (const id of ids) {
      expect(sql).toContain(`('${id}')`);
    }
  });

  it('every migration file exports an id matching its own filename', async () => {
    const ids = migrationIdsOnDisk();
    for (const id of ids) {
      const mod = await import(path.join(MIGRATIONS_DIR, `${id}.ts`));
      expect(mod.migration?.id).toBe(id);
    }
  });
});
