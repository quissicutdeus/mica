// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0002_phone_data_follows_the_phone';

/**
 * MICA-282's migration, as text — only the guards at its top, which decide whether it runs at
 * all. What it does to a real database is `pnpm test:migrations`' (`runDataMigration`, and
 * MICA-389's `runApplyFinishesHalfCreated` for these guards on every half-created shape).
 */

/** Which tables and columns `information_schema` reports. Absent means not there. */
const live = (present: { tables?: string[]; columns?: string[] }) => {
  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/information_schema\.TABLES/.test(sql)) {
      return (present.tables ?? []).includes(String(params[0])) ? 1 : 0;
    }
    if (/information_schema\.COLUMNS/.test(sql)) {
      return (present.columns ?? []).includes(`${params[0]}.${params[1]}`) ? 1 : 0;
    }
    return 0;
  });
};

const ran = () => dbMock.query.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dbMock.query.mockResolvedValue([]);
});

describe('0002_phone_data_follows_the_phone', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0002_phone_data_follows_the_phone');
  });

  it('does nothing past a final-shape schema: no mica_phones, and device_id on contacts', async () => {
    live({ tables: ['mica_contacts'], columns: ['mica_contacts.device_id'] });

    await migration.up();

    expect(ran()).toEqual([]);
  });

  /**
   * MICA-389: a first-start create that stopped before `mica_contacts`. The migration used to
   * `ALTER` the missing `mica_phones` there, which stopped `micaschema apply` before its creates.
   */
  it('does nothing where neither mica_phones nor mica_contacts exists', async () => {
    live({ tables: ['mica_battery', 'mica_blocklist'] });

    await expect(migration.up()).resolves.toBeUndefined();

    expect(ran()).toEqual([]);
  });

  it('still goes on — and so fails on mica_phones — when contacts has no device_id', async () => {
    // The re-import over an older database: its contacts table predates `device_id`, and the
    // migration must fail on the missing `mica_phones` rather than record work it never did.
    live({ tables: ['mica_contacts'] });
    dbMock.query.mockRejectedValueOnce(new Error("Table 'db.mica_phones' doesn't exist"));

    await expect(migration.up()).rejects.toThrow("Table 'db.mica_phones' doesn't exist");

    expect(ran()[0]).toContain('ALTER TABLE `mica_phones` ADD COLUMN `claimed`');
  });
});
