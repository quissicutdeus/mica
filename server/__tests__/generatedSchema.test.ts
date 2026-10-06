// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { declaredServices } from '../lib/defineService';
import {
  auditLogDdl,
  createStatements,
  FRESH_DATABASE_PREDICATE,
  toSqlFile,
  SCHEMA_MIGRATIONS_TABLE,
  OWNER_TABLE
} from '../lib/schemaSql';
import '../services/index';

/**
 * `mica.sql` is generated, committed, and **imported by hand on a fresh install** —
 * nothing regenerates it, and no suite has ever checked that it still matches the
 * declarations it came from.
 *
 * That makes drift both consequential and invisible. A column added to a `defineService`
 * without re-running `pnpm generate:sql` means a fresh install creates the table without
 * it, while every existing install — brought up to date by `micaschema apply`, which
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

const MICA_SQL = path.join(__dirname, '..', '..', 'mica.sql');
const sql = fs.readFileSync(MICA_SQL, 'utf8');

const MICA_ESX_SQL = path.join(__dirname, '..', '..', 'mica.esx.sql');
const esxSql = fs.readFileSync(MICA_ESX_SQL, 'utf8');

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

describe('mica.sql matches the declarations it was generated from', () => {
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
        `mica.sql has no block for the '${id}' service. It was declared without running ` +
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
    // audit ledger (`auditLogDdl` in `server/lib/schemaSql.ts`), and the migrations ledger.
    const undeclared = new Set(['mica_audit_logs', SCHEMA_MIGRATIONS_TABLE]);

    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)].map((m) => m[1]);

    const orphans = created.filter((table) => !declared.has(table) && !undeclared.has(table));
    expect(
      orphans,
      'mica.sql creates tables nothing declares — a deleted or renamed service left ' +
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
      // `players` and anything else micaOS does not own is the server owner's problem,
      // not this file's ordering.
      if (targetAt === undefined) continue;
      if (targetAt > fk.index) violations.push(`${tableAt(fk.index)} references ${target}`);
    }

    expect(
      violations,
      'mica.sql references a table it has not created yet; importing it fails with ' + 'errno 150.'
    ).toEqual([]);
  });
});

/**
 * The ESX artifact (MICA-150), under the same rules as its qb twin.
 *
 * `players(citizenid)` is qb's table; micaOS references it and never creates it. ESX has no
 * such table, so a fresh `es_extended` server importing `mica.sql` fails part-way through
 * on the first of 22 constraints and micaOS cannot be installed at all.
 *
 * `mica.esx.sql` is the same declarations with those constraints omitted, emitted in the
 * same pass so it cannot drift from the code or from `mica.sql`. The three properties below
 * are what make it safe: it is generated rather than hand-maintained, it contains no reference
 * to a table ESX does not have, and — the one that would be silent — it is *only* the owner
 * keys that went, not the cross-app ones the tables genuinely depend on.
 */
describe('mica.esx.sql', () => {
  const esxBlock = (id: string): string | null => {
    const start = esxSql.indexOf(blockHeader(id));
    if (start === -1) return null;

    const nextService = esxSql.indexOf('\n-- Generated from the ', start + 1);
    const ledger = esxSql.indexOf('\n-- Versioned schema migrations ledger.', start + 1);
    const ends = [nextService, ledger].filter((i) => i !== -1);
    const end = ends.length > 0 ? Math.min(...ends) : esxSql.length;

    return esxSql.slice(start, end).trimEnd();
  };

  it.each(declaredServices.map((s) => [s.id, s] as const))(
    "%s's tables are in the ESX file, verbatim",
    (id, resolved) => {
      const committed = esxBlock(id);

      expect(
        committed,
        `mica.esx.sql has no block for the '${id}' service. Re-run \`pnpm generate:sql\`.`
      ).not.toBeNull();

      expect(committed).toBe(toSqlFile(resolved, { ownerTable: false }).trimEnd());
    }
  );

  it('references the players table nowhere — the whole reason the file exists', () => {
    // One assertion on the raw text rather than per-table, because a single survivor is
    // enough to abort the import, and it would abort it on somebody else's server. The
    // banner names the table in prose, so it is `REFERENCES` that is looked for and not the
    // word.
    expect(esxSql).not.toContain(`REFERENCES \`${OWNER_TABLE}\``);
    expect(esxSql).not.toContain('FOREIGN KEY (`citizenid`)');
  });

  it('creates exactly the same tables as the qb file', () => {
    const tablesIn = (text: string) =>
      [...text.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)].map((m) => m[1]);

    // Dropping a constraint must not drop a table with it, and the two files must not be
    // able to describe different schemas.
    expect(tablesIn(esxSql)).toEqual(tablesIn(sql));
  });

  it('keeps every foreign key that is not onto players', () => {
    // The failure this catches is over-stripping: a pattern that removed all constraints
    // rather than the owner ones would still import cleanly on ESX and would silently give
    // that server no referential integrity between micaOS's own tables.
    const fksIn = (text: string) => [...text.matchAll(/REFERENCES `([^`]+)`/g)].map((m) => m[1]);

    const kept = fksIn(esxSql);
    const expected = fksIn(sql).filter((table) => table !== OWNER_TABLE);

    expect(kept).toEqual(expected);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('leaves no table body ending in a comma', () => {
    // Removing the last constraint in a body leaves the line before it with a trailing
    // comma, which MySQL rejects. Only ever visible on a fresh ESX install.
    expect(esxSql).not.toMatch(/,\s*\n\s*\) ENGINE/);
  });
});

/**
 * MICA-306: the first-start bootstrap creates a fresh database from `createStatements`, not
 * from these files. The two are one schema only while every runtime `CREATE` is the file's,
 * byte for byte but for `IF NOT EXISTS` — the audit log and the ledger included, which no
 * declaration describes. A fresh install that skipped the import must not end up with a
 * different schema from one that imported.
 */
describe('the first-start statements match the generated files (MICA-306)', () => {
  /** Every `CREATE TABLE` in a file, as one statement each, `IF NOT EXISTS` removed. */
  const createsIn = (text: string): string[] =>
    [...text.matchAll(/^CREATE TABLE IF NOT EXISTS `[^`]+` \([\s\S]*?\n\) ENGINE = [^;]+;/gm)].map(
      (m) => m[0].replace('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE ')
    );

  it.each([
    ['mica.sql', sql, true],
    ['mica.esx.sql', esxSql, false]
  ] as const)('%s creates exactly what the bootstrap does, in the same order', (_f, text, qb) => {
    const runtime = createStatements(qb).filter((s) => s.startsWith('CREATE TABLE'));
    const fromFile = createsIn(text);

    // The files create the ledger last, beside their seed; the bootstrap creates it first,
    // as its claim on the database. Everything else is in the same order.
    const [ledger, ...rest] = runtime;
    expect(ledger.startsWith(`CREATE TABLE \`${SCHEMA_MIGRATIONS_TABLE}\``)).toBe(true);
    expect(fromFile).toEqual([...rest, ledger]);
    expect(fromFile.length).toBeGreaterThan(declaredServices.length);
  });

  it('includes the audit log, at the width each file gives it', () => {
    const audit = (text: string) =>
      createsIn(text).find((s) => s.startsWith('CREATE TABLE `mica_audit_logs`'));
    expect(audit(sql)).toBe(auditLogDdl({ ownerTable: true, plainCreate: true }));
    expect(audit(esxSql)).toBe(auditLogDdl({ ownerTable: false, plainCreate: true }));
    expect(audit(sql)).toContain('`citizenid` varchar(50) NOT NULL');
    expect(audit(esxSql)).toContain('`citizenid` varchar(60) NOT NULL');
  });

  it('asks the same freshness question the files seed by', () => {
    for (const text of [sql, esxSql]) {
      expect(text).toContain(`SET @mica_fresh_import = ${FRESH_DATABASE_PREDICATE};`);
    }
  });
});

/**
 * MICA-300: no micaOS table carries a foreign key onto the framework's `players` in either
 * file. Its `ON DELETE CASCADE` deleted a character's rows inside MariaDB before any report
 * hold or cascade guard could apply; the character-deleted purge and the orphan sweep decide
 * instead, and migration 0006 drops the constraint from an existing database.
 */
describe('no foreign key onto players (MICA-300)', () => {
  it.each([
    ['mica.sql', sql],
    ['mica.esx.sql', esxSql]
  ])('%s references players nowhere', (_file, text) => {
    expect(text).not.toContain(`REFERENCES \`${OWNER_TABLE}\``);
    expect(text).not.toContain('FOREIGN KEY (`citizenid`)');
  });

  /**
   * Those keys were also what made the wrong file fail loudly: `mica.sql` on es_extended
   * stopped at its first constraint. Without them it would import quietly at qb's width, four
   * characters short of an es_extended identifier (MICA-289). So `mica.sql` reads `players`
   * before it creates anything, and `mica.esx.sql` does not.
   */
  it('makes mica.sql fail on a server without players before it creates anything', () => {
    const guard = sql.indexOf('SELECT 1 FROM `players` LIMIT 0;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(esxSql).not.toMatch(/FROM `players`/);
  });
});
