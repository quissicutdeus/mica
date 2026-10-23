// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0017_audit_records_a_change';
import { AUDIT_LOG_ACTIONS } from '../lib/schemaSql';

/**
 * MICA-430's 0017, as text. `test:migrations` runs it against MariaDB on both shapes, twice;
 * this pins the one read, the append and the refusals.
 */
const BEFORE =
  "enum('archived','unarchived','deleted','left','removed','moderated','unmoderated','viewed')";
const AFTER =
  "enum('archived','unarchived','deleted','left','removed','moderated','unmoderated','viewed','changed')";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('0017_audit_records_a_change', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0017_audit_records_a_change');
  });

  it('appends changed, in place, after one read', async () => {
    dbMock.scalar.mockResolvedValue(BEFORE);
    await migration.up();
    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
    expect(dbMock.query.mock.calls.map(([sql]) => sql)).toEqual([
      "ALTER TABLE `mica_audit_logs` MODIFY COLUMN `action` ENUM('archived', 'unarchived', " +
        "'deleted', 'left', 'removed', 'moderated', 'unmoderated', 'viewed', 'changed') NOT NULL"
    ]);
  });

  it('does nothing a second time, nor on a ledger it never created', async () => {
    dbMock.scalar.mockResolvedValue(AFTER);
    await migration.up();
    dbMock.scalar.mockResolvedValue(null);
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a list that is not the start of its own, writing nothing', async () => {
    dbMock.scalar.mockResolvedValue("enum('viewed','archived')");
    await expect(migration.up()).rejects.toThrow(/not the start of/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('brings the ledger to what a fresh one is made with', () => {
    expect([...AUDIT_LOG_ACTIONS].at(-1)).toBe('changed');
    expect(AFTER).toBe(`enum(${AUDIT_LOG_ACTIONS.map((a) => `'${a}'`).join(',')})`);
  });
});
