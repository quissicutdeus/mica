// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  query: vi.fn(async (): Promise<unknown> => []),
  insert: vi.fn(),
  update: vi.fn(),
  scalar: vi.fn(async () => null),
  single: vi.fn(async (): Promise<unknown> => null)
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  FrameworkBridge,
  __setResourceLookup,
  __resetEsxPhoneColumn,
  __resetOfflineLookupWarnings
} from '../lib/FrameworkBridge';
import { ESX_PHONE_COLUMNS } from '../lib/framework/esx';

/**
 * MICA-225. Core es_extended has no phone column on `users`, and the resources that add one
 * disagree about its name, so the offline lookup by number used to answer nothing on ESX —
 * `GetCitizenId(phone)`, offline mail and contact sharing all silently did nothing there.
 * The adapter now asks `information_schema` which of three spellings the table has, once,
 * and reads through that one.
 *
 * What is worth pinning: the column that reaches SQL is only ever one of a frozen list
 * (it is interpolated as an identifier, §2.9), the probe runs once per resource start, and
 * a table with no such column — or a probe that throws — degrades to exactly the old
 * answer rather than to an error on the conversation being built around it.
 */

const esx = () =>
  __setResourceLookup((name) =>
    name === 'es_extended' ? { getSharedObject: () => ({}) } : undefined
  );

const probeAnswers = (columns: string[]) => {
  dbMock.query.mockImplementation(async (sql: string) =>
    String(sql).includes('information_schema')
      ? columns.map((COLUMN_NAME) => ({ COLUMN_NAME }))
      : []
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetEsxPhoneColumn();
  __resetOfflineLookupWarnings();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  esx();
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('an offline ESX player by phone number', () => {
  it('reads users through the column the probe found, and names the identity from it', async () => {
    probeAnswers(['phone_number']);
    dbMock.single.mockResolvedValueOnce({
      identifier: 'char1:license:abc',
      firstname: ' Ada ',
      lastname: 'Lovelace'
    });

    const found = await FrameworkBridge.findOfflineByPhone('5550001');

    expect(found).toEqual({
      citizenid: 'char1:license:abc',
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '5550001'
    });
    const [sql, params] = dbMock.single.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain('FROM users WHERE `phone_number` = ?');
    expect(params).toEqual(['5550001']);
  });

  it('probes information_schema once per resource start, scoped to the connected database', async () => {
    probeAnswers(['phone']);

    await FrameworkBridge.findOfflineByPhone('5550001');
    await FrameworkBridge.findOfflineByPhone('5550002');
    await FrameworkBridge.findOfflineByPhone('5550003');

    const probes = dbMock.query.mock.calls.filter(([sql]) =>
      String(sql).includes('information_schema')
    );
    expect(probes).toHaveLength(1);
    const [sql, params] = probes[0];
    expect(String(sql)).toContain('TABLE_SCHEMA = DATABASE()');
    // The table name and every candidate column are bound, never interpolated, on the probe.
    expect(params).toEqual(['users', ...ESX_PHONE_COLUMNS]);
    expect(dbMock.single).toHaveBeenCalledTimes(3);
  });

  it('only ever interpolates a column from the frozen allowlist, in allowlist order', async () => {
    // A table carrying two spellings — and a name the probe was never asked about, which a
    // permissive reading of the rows would otherwise let through to SQL.
    probeAnswers(['phone', 'phoneNumber', 'phone_hacked']);

    await FrameworkBridge.findOfflineByPhone('5550001');

    const sql = String(dbMock.single.mock.calls[0][0]);
    expect(sql).toContain('`phoneNumber` = ?');
    expect(sql).not.toContain('phone_hacked');
    expect(Object.isFrozen(ESX_PHONE_COLUMNS)).toBe(true);
  });

  it('answers null without touching users when the table has no number column', async () => {
    probeAnswers([]);

    await expect(FrameworkBridge.findOfflineByPhone('5550001')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('degrades to null, said once, when the probe itself throws', async () => {
    dbMock.query.mockRejectedValue(new Error('no such table'));

    await expect(FrameworkBridge.findOfflineByPhone('5550001')).resolves.toBeNull();
    await expect(FrameworkBridge.findOfflineByPhone('5550002')).resolves.toBeNull();

    expect(dbMock.single).not.toHaveBeenCalled();
    // One probe, one report: a thrown probe is cached as "no column" rather than retried per call.
    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it('is an unknown number, not an error, when no row holds it', async () => {
    probeAnswers(['phoneNumber']);
    dbMock.single.mockResolvedValueOnce(null);

    await expect(FrameworkBridge.findOfflineByPhone('5559999')).resolves.toBeNull();
  });
});
