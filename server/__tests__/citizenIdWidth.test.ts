// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { resolveAppSchema, buildRepository, declaredServices } from '../lib/defineService';
import { toCreateTableSql, toChildTableSql, expectedShape } from '../lib/schemaSql';
import { planAppMigration, isNoop, type LiveTable } from '../lib/migrate';
import { setOwnerTableResolver } from '../lib/ownerWidth';
import { migration } from '../migrations/0004_citizenid_widens_on_esx';
import '../services/index';

/**
 * MICA-289. A citizenid column is as wide as the owner key it holds: qb's
 * `players.citizenid` (50), or ESX's `users.identifier` (60) — where an es_extended
 * multicharacter identifier, 54 characters, used to be refused and cost that player a phone.
 */

afterEach(() => setOwnerTableResolver(() => null));

describe('declaring a citizenId column', () => {
  it('refuses a length beside it, or a type other than string', () => {
    expect(() =>
      resolveAppSchema({
        id: 'cidlen',
        schema: { owner: { type: 'string', length: 50, citizenId: true } }
      })
    ).toThrow(/'owner' is 'citizenId'/);
    expect(() =>
      resolveAppSchema({ id: 'cidint', schema: { owner: { type: 'int', citizenId: true } } })
    ).toThrow(/'citizenId'/);
  });

  it('refuses the same on a child table column', () => {
    expect(() =>
      resolveAppSchema({
        id: 'cidchild',
        schema: { x: 'text' },
        childTables: [
          {
            name: 'mica_cidchild_rows',
            columns: { citizenid: { type: 'string', length: 60, citizenId: true } }
          }
        ]
      })
    ).toThrow(/child table 'mica_cidchild_rows' column 'citizenid' is 'citizenId'/);
  });
});

describe('rendering the width for each file', () => {
  const resolved = resolveAppSchema({
    id: 'cidfile',
    schema: { payee: { type: 'string', citizenId: true } }
  });

  it('is 50 in mica.sql and 60 in mica.esx.sql, for the implicit column and a declared one', () => {
    const qb = toCreateTableSql(resolved);
    expect(qb).toContain('`citizenid` varchar(50) NOT NULL');
    expect(qb).toContain('`payee` varchar(50) DEFAULT NULL');

    const esx = toCreateTableSql(resolved, { ownerTable: false });
    expect(esx).toContain('`citizenid` varchar(60) NOT NULL');
    expect(esx).toContain('`payee` varchar(60) DEFAULT NULL');
  });

  it('sizes a child table column the same way', () => {
    const child = {
      name: 'mica_cidfile_rows',
      columns: { citizenid: { type: 'string' as const, citizenId: true, notNull: true } }
    };
    expect(toChildTableSql(child)).toContain('`citizenid` varchar(50) NOT NULL');
    expect(toChildTableSql(child, { ownerTable: false })).toContain(
      '`citizenid` varchar(60) NOT NULL'
    );
  });

  it('marks the columns that hold another character: payee and target_author', () => {
    const byId = new Map(declaredServices.map((s) => [s.id, s]));
    const invoices = byId.get('invoices')!;
    const reports = byId.get('reports')!;
    expect(invoices.fields.find((f) => f.name === 'payee')?.def.citizenId).toBe(true);
    expect(reports.fields.find((f) => f.name === 'target_author')?.def.citizenId).toBe(true);
  });
});

describe('the write guard reads this server', () => {
  const repo = buildRepository(
    resolveAppSchema({ id: 'cidguard', schema: { payee: { type: 'string', citizenId: true } } })
  );

  it('holds 50 on qb', () => {
    setOwnerTableResolver(() => true);
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(50))).not.toThrow();
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(51))).toThrow(
      /limited to 50 characters/
    );
  });

  it('holds 60 on ESX', () => {
    setOwnerTableResolver(() => false);
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(60))).not.toThrow();
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(61))).toThrow(
      /limited to 60 characters/
    );
  });

  it('holds the narrowest while the framework is unknown', () => {
    // `payee` is whatever a resource passed SendInvoice. In the boot window on qb, a wider
    // fallback would let 51–60 characters reach a varchar(50); refusing is the loud failure.
    setOwnerTableResolver(() => null);
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(50))).not.toThrow();
    expect(() => repo.assertWritableValue('payee', 'x'.repeat(51))).toThrow(
      /limited to 50 characters/
    );
  });
});

describe('the planner', () => {
  const resolved = resolveAppSchema({ id: 'cidplan', schema: { note: 'text' } });
  const shape = expectedShape(resolved);
  const liveAt = (width: number | null): LiveTable => ({
    exists: true,
    columns: shape.columns
      .filter((c) => width !== null || c.name !== 'citizenid')
      .map((c) => ({
        name: c.name,
        type:
          c.name === 'citizenid'
            ? `varchar(${width})`
            : c.name === 'id'
              ? 'int(11)'
              : c.name === 'note'
                ? 'text'
                : c.name === 'status'
                  ? "enum('active','deleted')"
                  : 'timestamp',
        nullable: !c.def.notNull
      })),
    indexes: ['PRIMARY', ...shape.indexes.map((i) => i.name)]
  });

  it('finds 50 current on qb and 60 current on ESX', () => {
    expect(isNoop(planAppMigration(resolved, liveAt(50), { ownerTable: true }))).toBe(true);
    expect(isNoop(planAppMigration(resolved, liveAt(60), { ownerTable: false }))).toBe(true);
  });

  it('reports an ESX column still at 50 as drift, which 0004 is what fixes', () => {
    const plan = planAppMigration(resolved, liveAt(50), { ownerTable: false });
    expect(plan.drift).toEqual([
      'mica_cidplan.citizenid is `varchar(50)` but declared `varchar(60)`'
    ]);
  });

  it('accepts either width while the framework is unknown, rather than guessing drift', () => {
    expect(isNoop(planAppMigration(resolved, liveAt(50), { ownerTable: null }))).toBe(true);
    expect(isNoop(planAppMigration(resolved, liveAt(60), { ownerTable: null }))).toBe(true);
    expect(planAppMigration(resolved, liveAt(55), { ownerTable: null }).drift).toHaveLength(1);
  });

  it('adds a missing column at this server width, and the wider one while unknown', () => {
    const add = (ownerTable: boolean | null) =>
      planAppMigration(resolved, liveAt(null), { ownerTable }).additive.map((s) => s.sql);
    expect(add(true)).toEqual([
      'ALTER TABLE `mica_cidplan` ADD COLUMN `citizenid` varchar(50) NOT NULL'
    ]);
    expect(add(null)).toEqual([
      'ALTER TABLE `mica_cidplan` ADD COLUMN `citizenid` varchar(60) NOT NULL'
    ]);
  });
});

/**
 * The 32 columns 0004 widens, as it shipped. A literal on purpose: the migration is frozen, and
 * a citizenId column declared after it is created at the right width and needs no migration,
 * so this must not follow today's declarations.
 */
const SHIPPED_0004 = [
  'mica_audit_logs.citizenid',
  'mica_accounts.citizenid',
  'mica_battery.citizenid',
  'mica_blabber_dms.citizenid',
  'mica_blocklist.citizenid',
  'mica_contacts.citizenid',
  'mica_messages_conversations.citizenid',
  'mica_messages_participants.citizenid',
  'mica_highscores.citizenid',
  'mica_hodlr.citizenid',
  'mica_import_ledger.citizenid',
  'mica_invoices.citizenid',
  'mica_invoices.payee',
  'mica_lockscreen.citizenid',
  'mica_mail.citizenid',
  'mica_media.citizenid',
  'mica_blabber.citizenid',
  'mica_blabber_attachments.citizenid',
  'mica_marketplace.citizenid',
  'mica_marketplace_attachments.citizenid',
  'mica_messages.citizenid',
  'mica_messages_attachments.citizenid',
  'mica_messages_reactions.citizenid',
  'mica_notes.citizenid',
  'mica_notifications.citizenid',
  'mica_phone_call_log.citizenid',
  'mica_phone_numbers.citizenid',
  'mica_phones.citizenid',
  'mica_places.citizenid',
  'mica_reports.citizenid',
  'mica_reports.target_author',
  'mica_settings.citizenid'
];

describe('0004_citizenid_widens_on_esx', () => {
  const alters = () =>
    dbMock.query.mock.calls.map((call) => String(call[0])).filter((sql) => sql.startsWith('ALTER'));

  /** `columns` maps `table.column` to its live shape; anything absent does not exist. */
  const database = (
    ownerForeignKeys: number,
    columns: Record<string, { length: number; nullable?: boolean; collation?: string }>
  ) => {
    dbMock.scalar.mockResolvedValue(ownerForeignKeys);
    dbMock.single.mockImplementation(async (_sql: string, [table, column]: string[]) => {
      const live = columns[`${table}.${column}`];
      if (!live) return null;
      return {
        CHARACTER_MAXIMUM_LENGTH: live.length,
        IS_NULLABLE: live.nullable ? 'YES' : 'NO',
        CHARACTER_SET_NAME: 'utf8mb4',
        COLLATION_NAME: live.collation ?? 'utf8mb4_unicode_ci'
      };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.query.mockResolvedValue([]);
  });

  it('is named for its file', () => {
    expect(migration.id).toBe('0004_citizenid_widens_on_esx');
  });

  it('leaves qb alone, with its foreign keys or without them', async () => {
    // Without them (MyISAM, or dropped by hand) is the case a database-shape test misses:
    // widened to 60, every column would then be drift against the planner's qb 50.
    setOwnerTableResolver(() => true);
    for (const keys of [3, 0]) {
      database(keys, { 'mica_notes.citizenid': { length: 50 } });
      await migration.up();
    }
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(alters()).toEqual([]);
  });

  it('refuses to guess while the framework is unknown, and stays pending', async () => {
    setOwnerTableResolver(() => null);
    database(0, { 'mica_notes.citizenid': { length: 50 } });
    await expect(migration.up()).rejects.toThrow(/has not been detected yet/);
    expect(alters()).toEqual([]);
  });

  it('leaves a non-qb database carrying players foreign keys alone, and says why', async () => {
    setOwnerTableResolver(() => false);
    database(3, { 'mica_notes.citizenid': { length: 50 } });
    await migration.up();
    expect(String(dbMock.scalar.mock.calls[0][0])).toContain("REFERENCED_TABLE_NAME = 'players'");
    expect(alters()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('mica.sql was imported'));
  });

  it('widens every narrower column on ESX and standalone, keeping nullability, charset and collation', async () => {
    setOwnerTableResolver(() => false);
    database(0, {
      'mica_notes.citizenid': { length: 50 },
      'mica_reports.target_author': { length: 50, nullable: true },
      'mica_audit_logs.citizenid': { length: 50, collation: 'utf8mb4_uca1400_ai_ci' },
      'mica_phones.citizenid': { length: 60 }
    });

    await migration.up();

    expect(alters()).toEqual([
      'ALTER TABLE `mica_audit_logs` MODIFY `citizenid` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL',
      'ALTER TABLE `mica_notes` MODIFY `citizenid` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
      'ALTER TABLE `mica_reports` MODIFY `target_author` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL'
    ]);
  });

  it('walks exactly the columns it shipped with', async () => {
    setOwnerTableResolver(() => false);
    database(0, {});
    await migration.up();

    const listed = dbMock.single.mock.calls.map(([, [table, column]]) => `${table}.${column}`);
    expect(listed).toEqual(SHIPPED_0004);
  });
});
