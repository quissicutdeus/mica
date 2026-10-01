// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { runCommand } from '../lib/mica';
import { sleep } from '../lib/wait';

/**
 * The schema the harness imported, against what micaOS declares (MICA-289, MICA-301).
 *
 * The shipped `mica.esx.sql` is read from the running `mica` resource itself — the file the
 * harness imported — so these check the release that is actually running, not a copy in this
 * resource that could be from another build.
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

export const schemaScenarios: Scenario[] = [
  {
    // MICA-289 (the ESX/standalone file), MICA-301: every table the declarations generate is
    // in the database the shipped file was imported into.
    id: 'schema-every-shipped-table-exists',
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
