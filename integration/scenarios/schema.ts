// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { runCommand } from '../lib/mica';
import { eventually, sleep } from '../lib/wait';

/**
 * The schema micaOS made for itself, against what the shipped file declares (MICA-289, MICA-301,
 * MICA-306).
 *
 * The box's wrapper imports nothing before this suite: micaOS starts on an empty database and
 * creates the schema on its first start (MICA-306), so every table and ledger row read here is
 * the bootstrap's. The release smoke test is the run that imports the file.
 *
 * The shipped `mica.esx.sql` is read from the running `mica` resource itself, so these check the
 * release that is actually running, not a copy in this resource that could be from another
 * build — and, since the bootstrap and that file are generated from one declaration, a table
 * the file names and the database lacks is the bootstrap's omission.
 */
const shippedSql = (): string => {
  const text = LoadResourceFile('mica', 'mica.esx.sql');
  if (!text) throw new Error('the mica resource ships no mica.esx.sql to read');
  return text;
};

/** Every `CREATE TABLE IF NOT EXISTS` the shipped file runs. */
const shippedTables = (sql: string): string[] =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z0-9_]+)`/g)].map((m) => m[1]);

/** The migration ids the shipped file seeds the ledger with, on a fresh import (MICA-301). */
const seededMigrations = (sql: string): string[] => {
  const at = sql.indexOf('INSERT IGNORE INTO `mica_schema_migrations`');
  if (at < 0) throw new Error('the shipped mica.esx.sql does not seed the migrations ledger');
  const block = sql.slice(at, sql.indexOf(';', at));
  return [...block.matchAll(/'(\d{4}_[a-z0-9_]+)'/g)].map((m) => m[1]);
};

/**
 * Ids that share the ledger without being migrations, each written by a feature that documents
 * it: the content-encryption marker (MICA-165) and the retention grace markers (MICA-167).
 */
const NOT_A_MIGRATION = /^(content-cipher:enabled|retention:[a-z0-9_]+:\d+d)$/;

const ledgerIds = async (): Promise<string[]> =>
  (await db.rows('SELECT `id` FROM `mica_schema_migrations` ORDER BY `id`')).map((r) =>
    String(r.id)
  );

/**
 * What micaOS says when its first-start create does not finish. It is printed once, early, and
 * this resource's console listener may not have been registered yet, so seeing none of these
 * proves nothing alone: the wrapper holds the whole console to the success line, and this reads
 * the tables. But a refusal this resource *did* hear is a failure with its reason attached.
 */
export const BOOTSTRAP_REFUSED =
  /this database may be half-created|creating micaOS's schema stopped|micaOS created nothing|could not tell whether this database already holds|another server is creating micaOS's schema/;

export const schemaScenarios: Scenario[] = [
  {
    // MICA-306: the schema this run reads was made by micaOS's own first start, on a database
    // the wrapper left empty — and it finished, which the ledger's seed (written last) shows.
    id: 'schema-created-by-first-start-without-import',
    mode: 'standalone',
    tickets: ['MICA-306'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const mode = GetConvar('mica_integration_schema', '');
      if (mode !== 'bootstrap') {
        throw new Error(
          `mica_integration_schema is '${mode}', not 'bootstrap': this run was not set up to ` +
            'start micaOS on an empty database. The wrapper on the box predates MICA-306 (it ' +
            'imports mica.esx.sql first, so the first-start schema is unproven here); ' +
            'reinstall scripts/deploy/mica-smoke-release.sh as scripts/deploy/README.md says.'
        );
      }

      // The seed is the bootstrap's last statement, so a ledger with rows is a create that
      // reached its end. Until then the table may not exist yet, which is not an answer.
      await eventually(
        async () => {
          try {
            const rows = await db.count('SELECT COUNT(*) FROM `mica_schema_migrations`');
            return rows > 0 ? rows : null;
          } catch {
            return null;
          }
        },
        30_000,
        signal,
        'the first-start bootstrap to seed the migrations ledger'
      );

      const expected = seededMigrations(shippedSql());
      if (expected.length === 0) throw new Error('the shipped file seeds no migration id');
      const migrations = (await ledgerIds()).filter((id) => !NOT_A_MIGRATION.test(id));
      if (JSON.stringify(migrations) !== JSON.stringify(expected)) {
        throw new Error(
          `the ledger the bootstrap seeded is not the shipped list: has ${migrations.join(', ')}; ` +
            `expected ${expected.join(', ')}`
        );
      }

      // Standalone is the ESX shape: citizenid 60 wide, sized by the framework the bootstrap
      // detected, not defaulted. The audit log is one of the tables no declaration owns.
      const width = await db.row(
        'SELECT `COLUMN_TYPE` AS `type` FROM information_schema.COLUMNS ' +
          "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'mica_audit_logs' " +
          "AND `COLUMN_NAME` = 'citizenid'"
      );
      if (width?.type !== 'varchar(60)') {
        throw new Error(
          `mica_audit_logs.citizenid is ${String(width?.type)}; standalone takes the ESX width, varchar(60)`
        );
      }

      const tap = requireTap();
      const refused = tap.since(0).filter((line) => BOOTSTRAP_REFUSED.test(line));
      if (refused.length > 0) {
        throw new Error(`micaOS refused to create the schema: ${refused.join(' | ')}`);
      }
    }
  },
  {
    // MICA-289 (the ESX/standalone file), MICA-301: every table the declarations generate is
    // in the database the shipped file was imported into.
    id: 'schema-every-shipped-table-exists',
    mode: 'standalone',
    tickets: ['MICA-289', 'MICA-301'],
    run: async () => {
      const expected = shippedTables(shippedSql());
      if (expected.length < 20) {
        throw new Error(`the shipped file names only ${expected.length} tables`);
      }
      const live = new Set(
        (
          await db.rows(
            'SELECT `TABLE_NAME` AS `name` FROM information_schema.TABLES ' +
              'WHERE `TABLE_SCHEMA` = DATABASE()'
          )
        ).map((r) => String(r.name))
      );
      const missing = expected.filter((table) => !live.has(table));
      if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);
    }
  },
  {
    // MICA-301: the ledger holds every migration the shipped file seeds, once each, and
    // nothing else but the markers that share it on purpose.
    id: 'schema-migrations-ledger-seeded-and-consistent',
    mode: 'standalone',
    tickets: ['MICA-301'],
    run: async () => {
      const seeded = seededMigrations(shippedSql());
      if (seeded.length === 0) throw new Error('the shipped file seeds no migration id');
      const ids = await ledgerIds();
      const missing = seeded.filter((id) => !ids.includes(id));
      if (missing.length > 0) throw new Error(`not in the ledger: ${missing.join(', ')}`);
      const stray = ids.filter((id) => !seeded.includes(id) && !NOT_A_MIGRATION.test(id));
      if (stray.length > 0) {
        throw new Error(`in the ledger, neither seeded nor a known marker: ${stray.join(', ')}`);
      }
      const sorted = [...seeded].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(seeded)) {
        throw new Error('the shipped seed is not in apply order');
      }
    }
  },
  {
    // MICA-301, MICA-300, MICA-289: on a fresh import, `micaschema` reports nothing to do and
    // `micaschema apply` (console only) applies nothing — no migration re-run against tables
    // already in their new shape, no foreign key to drop, no additive column or index.
    id: 'schema-micaschema-report-and-apply-clean-on-fresh-import',
    mode: 'standalone',
    tickets: ['MICA-301', 'MICA-300', 'MICA-289'],
    timeoutMs: 40_000,
    run: async (signal) => {
      const tap = requireTap();
      const before = await ledgerIds();

      let mark = tap.mark();
      await runCommand('micaschema');
      await tap.waitFor(
        mark,
        /^\[mica\] schema is up to date\.$/,
        15_000,
        signal,
        "'[mica] schema is up to date.' from micaschema"
      );

      mark = tap.mark();
      await runCommand('micaschema apply');
      await tap.waitFor(
        mark,
        /^\[mica\] schema is already up to date\.$/,
        20_000,
        signal,
        "'[mica] schema is already up to date.' from micaschema apply"
      );
      await sleep(500);
      const changed = tap
        .since(mark)
        .filter((line) => /^\[mica\] (applied migration|dropped|migration .* failed)/.test(line));
      if (changed.length > 0) throw new Error(`apply changed something: ${changed.join(' | ')}`);

      const after = await ledgerIds();
      const migrationsOnly = (ids: string[]) => ids.filter((id) => !NOT_A_MIGRATION.test(id));
      if (JSON.stringify(migrationsOnly(before)) !== JSON.stringify(migrationsOnly(after))) {
        throw new Error('micaschema apply changed the migrations recorded in the ledger');
      }
    }
  }
];
