import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { declaredServices } from '../lib/defineService';
import { toSqlFile, SCHEMA_MIGRATIONS_TABLE } from '../lib/schemaSql';
import '../services/index';

/**
 * `gphone.sql` is generated, committed, and **imported by hand on a fresh install** —
 * nothing regenerates it, and no suite has ever checked that it still matches the
 * declarations it came from.
 *
 * That makes drift both consequential and invisible. A column added to a `defineService`
 * without re-running `pnpm generate:sql` means a fresh install creates the table without
 * it, while every existing install — brought up to date by `gphoneschema apply`, which
 * reads the declarations rather than this file — is fine. Every suite stays green, every
 * developer machine stays working, and only a new server owner ever sees it.
 *
 * So this reads the committed artifact and compares it against what the declarations
 * would emit right now. It re-uses `toSqlFile`, the same emitter `scripts/generate-sql.js`
 * calls, rather than restating the DDL: the failure this guards against is a stale file,
 * not a broken emitter, and a hand-written expectation would be a second copy to drift.
 *
 * What it deliberately does not re-derive is the file *assembly* — the banner, and the
 * Kahn sort in `generate-sql.js` that orders apps by their cross-app foreign keys.
 * Reimplementing those here would assert the test against itself. The ordering is checked
 * from the artifact instead (see the third block), which is the property that actually
 * matters when somebody imports the file.
 *
 * Nothing here touches a database. It proves the file agrees with the code; only a real
 * MySQL import proves the file is valid SQL.
 */

const MICA_SQL = path.join(__dirname, '..', '..', 'gphone.sql');
const sql = fs.readFileSync(MICA_SQL, 'utf8');

/** The header `toSqlFile` stamps on each service's block, and our slice boundary. */
const blockHeader = (id: string) => `-- Generated from the '${id}' defineService declaration.`;

/**
 * The service's block as the committed file actually has it: from its header to the start
 * of whatever the generator emitted next — another service, or the migrations ledger.
 * Sliced rather than matched with `toContain` so a mismatch reports a line diff instead of
 * "a 30-line string was not found".
 */
function committedBlock(id: string): string | null {
  const start = sql.indexOf(blockHeader(id));
  if (start === -1) return null;

  const nextService = sql.indexOf('\n-- Generated from the ', start + 1);
  const ledger = sql.indexOf('\n-- Versioned schema migrations ledger.', start + 1);
  const ends = [nextService, ledger].filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : sql.length;

  return sql.slice(start, end).trimEnd();
}

describe('gphone.sql matches the declarations it was generated from', () => {
  it('has at least one service to check', () => {
    // A mocked-away or reordered import graph would leave `declaredServices` empty, and
    // every `it.each` below would silently pass by running zero cases.
    expect(declaredServices.length).toBeGreaterThan(0);
  });

  it.each(declaredServices.map((s) => [s.id, s] as const))(
    "%s's table and child tables are in the committed file, verbatim",
    (id, resolved) => {
      const committed = committedBlock(id);

      expect(
        committed,
        `gphone.sql has no block for the '${id}' service. It was declared without running ` +
          '`pnpm generate:sql`, so a fresh install never creates its table.'
      ).not.toBeNull();

      expect(committed).toBe(toSqlFile(resolved).trimEnd());
    }
  );

  it('creates no table that no declaration owns', () => {
    const declared = new Set<string>();
    for (const service of declaredServices) {
      declared.add(service.table);
      for (const child of service.childTables) declared.add(child.name);
    }

    // The two the generator emits with no `defineService` behind them: the moderation
    // audit ledger from `scripts/framework-schema.sql`, and the migrations ledger.
    const undeclared = new Set(['gphone_audit_logs', SCHEMA_MIGRATIONS_TABLE]);

    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)].map((m) => m[1]);

    const orphans = created.filter((table) => !declared.has(table) && !undeclared.has(table));
    expect(
      orphans,
      'gphone.sql creates tables nothing declares — a deleted or renamed service left ' +
        'behind, or a hand edit. Re-run `pnpm generate:sql`.'
    ).toEqual([]);

    // The other direction is covered per-service above, but only for services the file
    // already has a block for. This catches the count drifting either way.
    expect(new Set(created)).toEqual(new Set([...declared, ...undeclared]));
  });

  it('creates every foreign-key target before the table that references it', () => {
    // Read from the artifact, not from the Kahn sort that produced it: what has to hold
    // for a hand-import to succeed is that MySQL never meets a REFERENCES onto a table it
    // has not created yet (errno 150). Cross-app foreign keys make alphabetical order
    // wrong, so this is a real failure mode of the emitted file rather than of the code.
    const createdAt = new Map<string, number>();
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)) {
      if (!createdAt.has(match[1])) createdAt.set(match[1], match.index);
    }

    const tableAt = (offset: number): string => {
      let owner = '(before any CREATE TABLE)';
      for (const [table, at] of createdAt) if (at <= offset) owner = table;
      return owner;
    };

    const violations: string[] = [];
    // REFERENCES sits on its own line for most constraints, so match across the newline.
    for (const fk of sql.matchAll(/FOREIGN KEY \([^)]*\)\s*REFERENCES `([^`]+)`/g)) {
      const target = fk[1];
      const targetAt = createdAt.get(target);
      // `players` and anything else gPhone does not own is the server owner's problem,
      // not this file's ordering.
      if (targetAt === undefined) continue;
      if (targetAt > fk.index) violations.push(`${tableAt(fk.index)} references ${target}`);
    }

    expect(
      violations,
      'gphone.sql references a table it has not created yet; importing it fails with ' +
        'errno 150.'
    ).toEqual([]);
  });
});
