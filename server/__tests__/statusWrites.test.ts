// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn(),
    transaction: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  LEDGER_TABLE,
  __setStatusWritesForTests,
  resetStatusWrites,
  statusWritesMayRun
} from '../lib/statusWrites';
import { SCHEMA_MIGRATIONS_TABLE } from '../lib/schemaSql';
import { migrations } from '../migrations';
import { writeVersioned } from '../lib/versions';

/**
 * Nothing that moves a status on its own schedule runs while the database is behind the code
 * (review of MICA-428–430, replayed on a copy of a live database): before `micaschema apply`
 * the status it writes may not be in the ENUM, and under `sql_mode=''` MariaDB writes `''`.
 * `test:migrations` proves the write on a real engine; this holds the check's own logic.
 */
const ALL_APPLIED = migrations.map((m) => ({ id: m.id }));
let ledger: { id: string }[];
let statuses: { t: string; type: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  __setStatusWritesForTests(null);
  ledger = [...ALL_APPLIED];
  statuses = [
    { t: 'mica_notifications', type: "enum('active','deleted','moderated','expired','erased')" },
    { t: 'mica_versions', type: "enum('active','deleted','erased')" }
  ];
  dbMock.query.mockImplementation(async (sql: string) =>
    String(sql).includes(LEDGER_TABLE) ? ledger : statuses
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setStatusWritesForTests(true);
  vi.restoreAllMocks();
});

const held = () =>
  (console.error as any).mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.includes('is held'));

describe('statusWritesMayRun', () => {
  it('reads the ledger by its own name, which is the one the schema creates', () => {
    expect(LEDGER_TABLE).toBe(SCHEMA_MIGRATIONS_TABLE);
  });

  it('lets a write run on a current database, read once and then remembered', async () => {
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(true);
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(true);
    expect(dbMock.query).toHaveBeenCalledTimes(2);
  });

  it('holds every write while a migration is pending, and says so once per job', async () => {
    ledger = ALL_APPLIED.filter((row) => row.id !== '0015_hidden_rows_are_kept');
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(false);
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(false);
    expect(await statusWritesMayRun('a sweep', {})).toBe(false);
    expect(held()).toEqual([
      expect.stringContaining('a prune is held'),
      expect.stringContaining('a sweep is held')
    ]);
    expect(held()[0]).toContain('pending migrations: 0015_hidden_rows_are_kept');
    expect(held()[0]).toContain("Run 'micaschema apply'");
  });

  it('holds a write whose status is not in the live ENUM, or whose table has none', async () => {
    statuses = [{ t: 'mica_notifications', type: "enum('active','deleted','moderated')" }];
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(false);
    expect(held()[0]).toContain("mica_notifications.status lacks 'expired'");
    expect(await statusWritesMayRun('an edit', { mica_versions: ['active'] })).toBe(false);
    expect(held()[1]).toContain('mica_versions has no status column yet');
    // The positive twin: a status the ENUM has runs.
    expect(await statusWritesMayRun('a delete', { mica_notifications: ['deleted'] })).toBe(true);
  });

  it('fails closed when the database cannot be read', async () => {
    dbMock.query.mockRejectedValue(new Error('gone away'));
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(false);
  });

  /**
   * MICA-430 re-review: no migration pending, but a table only the additive pass creates is
   * missing. Another server's apply creates it; this one sees it within a minute, unreset.
   */
  it('reads again a minute on when a job is held with no migration pending', async () => {
    statuses = [{ t: 'mica_notifications', type: "enum('active','expired')" }];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(await statusWritesMayRun('an edit', { mica_versions: ['active'] })).toBe(false);
    // A job the same answer serves is not held by the other's gap.
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(true);
    statuses = [...statuses, { t: 'mica_versions', type: "enum('active','deleted','erased')" }];
    now.mockReturnValue(1_030_000);
    expect(await statusWritesMayRun('an edit', { mica_versions: ['active'] })).toBe(false);
    expect(dbMock.query).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_061_000);
    expect(await statusWritesMayRun('an edit', { mica_versions: ['active'] })).toBe(true);
    expect(dbMock.query).toHaveBeenCalledTimes(4);
  });

  it('asks again after micaschema apply resets it', async () => {
    ledger = [];
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(false);
    ledger = [...ALL_APPLIED];
    resetStatusWrites();
    expect(await statusWritesMayRun('a prune', { mica_notifications: ['expired'] })).toBe(true);
  });

  it('refuses a versioned edit whole while the ledger is behind: no version, no edit', async () => {
    ledger = [];
    await expect(
      writeVersioned({
        table: 'mica_notes',
        values: ['title'],
        context: ['citizenid'],
        hasUpdatedAt: true,
        where: '`id` = ?',
        whereParams: [1],
        next: { title: 'x' },
        reason: 'edit',
        editedBy: 'CIT_A',
        set: { sql: '`title` = ?', params: ['x'] }
      })
    ).rejects.toMatchObject({ name: 'PlayerFacingError', key: 'server.versions.notReady' });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});
