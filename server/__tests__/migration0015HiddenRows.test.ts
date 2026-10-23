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

import { migration } from '../migrations/0015_hidden_rows_are_kept';
import { declaredServices } from '../lib/defineService';
import { blabber } from '../services/Blabber';
import { spark } from '../services/Spark';
import { hodlr } from '../services/Hodlr';
import { highscores } from '../services/Highscores';
import { settings } from '../services/Settings';
import { blocklist } from '../services/Blocklist';
import { conversations } from '../services/Conversations';
import '../services/index';

/**
 * MICA-428's migration, as text. `pnpm test:migrations` runs it against a real MariaDB on both
 * framework shapes; this pins the guards, the append-only rule, and that what it restates is
 * what the declarations say today.
 */

/** The live schema `information_schema` answers: each table's status type, keys and columns. */
let live: {
  /** `citizenid`'s type: 50 wide on qb, 60 once 0004 has widened it on ESX. */
  citizenid: string;
  /** Plain columns that exist, as `table.column`: what a rebuilt column is placed after. */
  plain: Set<string>;
  tables: Set<string>;
  status: Map<string, string>;
  generation: Map<string, string>;
  keys: Set<string>;
};

/** Every statement sent, one line each. */
const sent = () => dbMock.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
/** The writes: what 0015 changed, without its reads of `information_schema`. */
const statements = () => sent().filter((q) => !q.startsWith('SELECT'));

/** What `information_schema` spells for an ENUM. */
const enumType = (values: readonly string[]) => `enum(${values.map((v) => `'${v}'`).join(',')})`;

/** Every declared status list, as `defineService` resolved it: what 0015 must bring a table to. */
const declared = (): Map<string, readonly string[]> => {
  const out = new Map<string, readonly string[]>();
  for (const service of declaredServices) {
    out.set(service.table, service.statuses);
    for (const child of service.childTables) {
      const spec = child.columns.status;
      if (spec && typeof spec !== 'string' && spec.type === 'enum' && spec.values) {
        out.set(child.name, spec.values);
      }
    }
  }
  return out;
};

/** A table as it stood before MICA-428: the declared list without what 0015 appends. */
const before = (values: readonly string[]) =>
  values.filter((value) => value !== 'erased' && value !== 'expired' && value !== '');

beforeEach(() => {
  vi.clearAllMocks();
  live = {
    citizenid: 'varchar(50)',
    plain: new Set(),
    tables: new Set(),
    status: new Map(),
    generation: new Map(),
    keys: new Set()
  };
  for (const [table, values] of declared()) {
    live.tables.add(table);
    // `mica_invoices` had its own `expired` before MICA-428, in its own place.
    const old = table === 'mica_invoices' ? values.filter((v) => v !== 'erased') : before(values);
    live.status.set(table, enumType(old));
  }
  live.generation.set(
    'mica_blabber.mouth_key',
    "case when `status` <> 'deleted' then `mouth_of` else NULL end"
  );
  live.generation.set(
    'mica_spark.live_citizen',
    "case when `status` <> 'deleted' then `citizenid` else NULL end"
  );
  live.keys.add('mica_blabber.account_mouth_key');
  live.keys.add('mica_spark.live_citizen');
  // The four keys over the plain owner or phone, as they stood before MICA-428.
  live.keys.add('mica_hodlr.citizenid_unique');
  live.keys.add('mica_highscores.citizenid_app');
  live.keys.add('mica_settings.device_app_key');
  live.keys.add('mica_blocklist.device_number_unique');
  live.keys.add('mica_messages_participants.conversation_device_unique');
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    // The three reads (MICA-428 review): each table's status type; the key tables' columns;
    // their indexes. Only what `live` holds for a table that exists, as `information_schema`.
    const asked = (params as string[]).filter((table) => live.tables.has(table));
    if (sql.includes("column_name = 'status'")) {
      return asked
        .filter((table) => live.status.has(table))
        .map((table) => ({ table, type: live.status.get(table) }));
    }
    if (sql.includes('information_schema.COLUMNS')) {
      return asked.flatMap((table) => [
        { table, column: 'citizenid', type: live.citizenid, generation: '' },
        { table, column: 'device_id', type: 'varchar(32)', generation: '' },
        ...[...live.plain]
          .filter((key) => key.startsWith(`${table}.`))
          .map((key) => ({ table, column: key.split('.')[1], type: 'int(11)', generation: '' })),
        ...[...live.generation]
          .filter(([key]) => key.startsWith(`${table}.`))
          .map(([key, generation]) => ({
            table,
            column: key.split('.')[1],
            type: 'varchar(50)',
            generation
          }))
      ]);
    }
    if (sql.includes('information_schema.STATISTICS')) {
      return [...live.keys]
        .filter((key) => asked.includes(key.split('.')[0]))
        .map((key) => ({ table: key.split('.')[0], index: key.split('.')[1] }));
    }
    const modify = /^ALTER TABLE `(\w+)` MODIFY COLUMN `status` ENUM\((.*)\) NOT NULL/.exec(sql);
    if (modify) {
      live.status.set(modify[1], `enum(${modify[2].replace(/, /g, ',')})`);
      return [];
    }
    // A rekey, as MariaDB would leave it: keys dropped and added, the column's expression.
    const table = /^ALTER TABLE `(\w+)`/.exec(sql)?.[1];
    for (const [, key] of sql.matchAll(/DROP KEY `(\w+)`/g)) live.keys.delete(`${table}.${key}`);
    for (const [, key] of sql.matchAll(/ADD UNIQUE KEY `(\w+)`/g)) live.keys.add(`${table}.${key}`);
    const added = /ADD COLUMN `(\w+)` \S+ GENERATED ALWAYS AS \((.*)\) VIRTUAL/.exec(sql);
    if (added) live.generation.set(`${table}.${added[1]}`, added[2].toLowerCase());
    return [];
  });
});

describe('0015_hidden_rows_are_kept', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0015_hidden_rows_are_kept');
  });

  it('brings every status ENUM to what the declarations say, by appending', async () => {
    await migration.up();

    // Every status table, child tables with a status included: not a loop over nothing.
    expect(declared().size).toBeGreaterThanOrEqual(32);
    expect(declared().get('mica_messages_participants')).toContain('erased');
    for (const [table, values] of declared()) {
      expect(live.status.get(table), table).toBe(enumType(values));
    }
    for (const sql of statements().filter((q) => q.includes('MODIFY COLUMN `status`'))) {
      expect(sql).toMatch(/ENUM\(.*\) NOT NULL DEFAULT 'active'$/);
    }
  });

  it('restates every key in one statement each, drop and add, never MODIFY', async () => {
    await migration.up();

    const rekeys = statements().filter((q) => q.includes('ADD UNIQUE KEY'));
    expect(rekeys).toEqual([
      'ALTER TABLE `mica_blabber` DROP KEY `account_mouth_key`, DROP COLUMN `mouth_key`, ' +
        "ADD COLUMN `mouth_key` int(11) GENERATED ALWAYS AS (CASE WHEN `status` NOT IN ('deleted', " +
        "'expired', 'erased') THEN `mouth_of` ELSE NULL END) VIRTUAL, " +
        'ADD UNIQUE KEY `account_mouth_key` (`account_id`, `mouth_key`)',
      'ALTER TABLE `mica_spark` DROP KEY `live_citizen`, DROP COLUMN `live_citizen`, ' +
        'ADD COLUMN `live_citizen` varchar(50) GENERATED ALWAYS AS (CASE WHEN `status` NOT IN ' +
        "('deleted', 'expired', 'erased') THEN `citizenid` ELSE NULL END) VIRTUAL, " +
        'ADD UNIQUE KEY `live_citizen` (`live_citizen`)',
      // Over a copy of the owner or phone an erased row does not carry; the old key goes in
      // the same statement, so a live server is never without one.
      'ALTER TABLE `mica_hodlr` DROP KEY `citizenid_unique`, ' +
        "ADD COLUMN `live_citizen` varchar(50) GENERATED ALWAYS AS (CASE WHEN `status` <> 'erased' " +
        'THEN `citizenid` ELSE NULL END) VIRTUAL, ADD UNIQUE KEY `live_citizen` (`live_citizen`)',
      'ALTER TABLE `mica_highscores` DROP KEY `citizenid_app`, ' +
        "ADD COLUMN `live_citizen` varchar(50) GENERATED ALWAYS AS (CASE WHEN `status` <> 'erased' " +
        'THEN `citizenid` ELSE NULL END) VIRTUAL, ADD UNIQUE KEY `live_citizen_app` (`live_citizen`, `app`)',
      'ALTER TABLE `mica_settings` DROP KEY `device_app_key`, ' +
        "ADD COLUMN `live_device` varchar(32) GENERATED ALWAYS AS (CASE WHEN `status` <> 'erased' " +
        'THEN `device_id` ELSE NULL END) VIRTUAL, ' +
        'ADD UNIQUE KEY `live_device_app_key` (`live_device`, `app`, `setting_key`)',
      // A thread's one membership per phone (MICA-428 review): an erased one holds no seat.
      'ALTER TABLE `mica_messages_participants` DROP KEY `conversation_device_unique`, ' +
        "ADD COLUMN `live_device` varchar(32) GENERATED ALWAYS AS (CASE WHEN `status` <> 'erased' " +
        'THEN `device_id` ELSE NULL END) VIRTUAL AFTER `device_id`, ' +
        'ADD UNIQUE KEY `conversation_live_device` (`conversation_id`, `live_device`)',
      'ALTER TABLE `mica_blocklist` DROP KEY `device_number_unique`, ' +
        "ADD COLUMN `live_device` varchar(32) GENERATED ALWAYS AS (CASE WHEN `status` <> 'erased' " +
        'THEN `device_id` ELSE NULL END) VIRTUAL, ' +
        'ADD UNIQUE KEY `live_device_number` (`live_device`, `number`)'
    ]);
    expect(statements().some((q) => /MODIFY COLUMN `(mouth_key|live_\w+)`/.test(q))).toBe(false);
  });

  it('does nothing a second time', async () => {
    await migration.up();
    dbMock.query.mockClear();

    await migration.up();
    expect(statements()).toEqual([]);
  });

  /**
   * MICA-428 in-server: read one table and column at a time, 0015 made ~90 round trips, each a
   * server tick in game, and `micaschema apply` on an empty ledger ran past the in-server
   * suite's 15 s. Three reads, however many tables, and nothing else when there is nothing to do.
   */
  it('reads the schema in three statements, whatever the number of tables', async () => {
    await migration.up();
    dbMock.query.mockClear();

    await migration.up();
    expect(sent().map((q) => /FROM (information_schema\.\w+)/.exec(q)?.[1])).toEqual([
      'information_schema.COLUMNS',
      'information_schema.COLUMNS',
      'information_schema.STATISTICS'
    ]);
    expect(dbMock.scalar).not.toHaveBeenCalled();
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses a table whose ENUM is not the start of the new one, changing nothing there', async () => {
    live.status.set('mica_notes', enumType(['active', 'deleted', 'archived', 'moderated']));

    await expect(migration.up()).rejects.toThrow(/mica_notes\.status holds .* append the missing/);
    expect(statements().some((q) => q.startsWith('ALTER TABLE `mica_notes`'))).toBe(false);
  });

  it('skips a table this server never created', async () => {
    live.tables.clear();
    await migration.up();
    expect(statements()).toEqual([]);
  });

  /**
   * The planner compares a generated column by name only, so nothing else would see a fresh
   * install and an upgraded one disagree: today's declarations are 0015's statements, character
   * for character.
   */
  it('places a rebuilt column where a fresh import has it, when that column is there', async () => {
    live.plain.add('mica_hodlr.quantity');
    await migration.up();

    const sql = (table: string) =>
      statements().find((q) => q.startsWith(`ALTER TABLE \`${table}\` DROP KEY`))!;
    expect(sql('mica_hodlr')).toContain('ELSE NULL END) VIRTUAL AFTER `quantity`, ADD UNIQUE KEY');
    // Not there yet (the additive pass adds it after the migrations): appended instead.
    expect(sql('mica_highscores')).not.toContain('AFTER');
  });

  it('restates live_citizen at the width citizenid has, 60 on ESX', async () => {
    live.citizenid = 'varchar(60)';
    await migration.up();

    expect(statements().find((q) => q.startsWith('ALTER TABLE `mica_spark` DROP KEY'))).toContain(
      'ADD COLUMN `live_citizen` varchar(60) GENERATED ALWAYS AS'
    );
  });

  it('refuses a citizenid of a type it will not restate, changing nothing there', async () => {
    live.citizenid = 'varchar(50) CHARACTER SET latin1';
    await expect(migration.up()).rejects.toThrow(/mica_spark\.live_citizen would be/);
    // Its status ENUM was widened before, which needs no width; the key is left as it was.
    expect(statements().some((q) => q.startsWith('ALTER TABLE `mica_spark` DROP KEY'))).toBe(false);
  });

  it('restates the expressions the declarations have today', () => {
    const source = readFileSync(
      join(__dirname, '..', 'migrations', '0015_hidden_rows_are_kept.ts'),
      'utf8'
    ).replace(/['"\s+]+/g, '');
    const services = [blabber, spark, hodlr, highscores, settings, blocklist];
    expect(services.map((service) => service.resolved.table)).toEqual([
      'mica_blabber',
      'mica_spark',
      'mica_hodlr',
      'mica_highscores',
      'mica_settings',
      'mica_blocklist'
    ]);
    for (const service of services) {
      const keyed = service.resolved.fields.filter(({ def }) => def.generatedAs);
      expect(keyed.length, service.resolved.table).toBe(1);
      const { name, def } = keyed[0];
      const index = service.resolved.indexes.find((i) => i.unique && i.columns.includes(name))!;
      // The table, the column, its expression and the key over it, together, as declared.
      const spec =
        `table:${service.resolved.table},column:${name},` +
        `expression:${def.generatedAs},` +
        `key:{name:${index.name},columns:${index.columns.map((c) => `\`${c}\``).join(',')}}`;
      expect(source.replace(/(type|after):[\w()]+,/g, ''), service.resolved.table).toContain(
        spec.replace(/['"\s+]+/g, '')
      );
    }

    // And the one child table's (MICA-428 review): a thread's membership, which has no service.
    const members = conversations.resolved.childTables.find(
      (child) => child.name === 'mica_messages_participants'
    )!;
    const live = members.columns.live_device;
    const generatedAs = typeof live === 'object' ? live.generatedAs : undefined;
    expect(generatedAs).toBe("CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END");
    const index = members
      .indexes!.flatMap((i) =>
        Array.isArray(i) ? [] : [i as Exclude<typeof i, readonly string[]>]
      )
      .find((i) => i.unique && i.columns.includes('live_device'))!;
    const spec =
      `table:mica_messages_participants,column:live_device,expression:${generatedAs},` +
      `key:{name:${index.name},columns:${index.columns.map((c) => `\`${c}\``).join(',')}}`;
    expect(source.replace(/(type|after):[\w()]+,/g, '')).toContain(spec.replace(/['"\s+]+/g, ''));
  });
});
