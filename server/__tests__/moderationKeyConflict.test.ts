// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { moderateTarget, restoreTarget } from '../lib/moderation';
import { PlayerFacingError } from '../lib/errors';

/**
 * A takedown or a restore refused by a unique key built on `status` (MICA-330).
 *
 * `mica_blabber.account_mouth_key` frees a deleted mouth's slot. A mouth reported while live,
 * deleted by its author and mouthed again cannot then be marked moderated — that would be two
 * mouths of one Blab holding the key — and the admin acting on the report is told why in words
 * rather than handed the generic failure. `Reports.ts` already releases the claim on any throw.
 */

/** The text oxmysql rejects with across a resource boundary: the query, then the driver's line. */
const oxmysqlDuplicate = () =>
  new Error(
    'mica was unable to execute a query!\n' +
      'UPDATE `mica_blabber` SET `status` = ? WHERE `id` = ?\n' +
      '["moderated",11]\n' +
      "Duplicate entry '1-9' for key 'mica_blabber.account_mouth_key'"
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.insert.mockResolvedValue(1);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a status move a unique key refuses (MICA-330)', () => {
  it('answers a takedown readably, and audits nothing', async () => {
    dbMock.update.mockRejectedValueOnce(oxmysqlDuplicate());

    await expect(
      moderateTarget('mica_blabber', 11, 'ADMIN', 'report #3: spam')
    ).rejects.toBeInstanceOf(PlayerFacingError);

    // Nothing moved, so the ledger must not say it did.
    const audited = dbMock.insert.mock.calls.some(([sql]) => /mica_audit_logs/.test(String(sql)));
    expect(audited).toBe(false);
  });

  it('names the conflict, under a catalog key, and keeps the driver error as its cause', async () => {
    const driver = oxmysqlDuplicate();
    dbMock.update.mockRejectedValueOnce(driver);

    const error = (await restoreTarget('mica_blabber', 11, 'ADMIN', 'report #3 reopened').catch(
      (e: unknown) => e
    )) as PlayerFacingError & { cause?: unknown };

    expect(error).toBeInstanceOf(PlayerFacingError);
    expect(error.message).toMatch(/newer copy/);
    expect(error.message).not.toMatch(/mica_blabber|account_mouth_key/);
    expect(error.key).toBe('server.reports.targetConflict');
    expect(error.cause).toBe(driver);
  });

  it('passes any other failure through untouched', async () => {
    // A parameter that says "Duplicate entry" must not classify its own statement.
    const other = new Error(
      'mica was unable to execute a query!\nUPDATE …\n["Duplicate entry for key"]\nLost connection'
    );
    dbMock.update.mockRejectedValueOnce(other);

    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).rejects.toBe(other);
  });

  it('still moderates when nothing collides', async () => {
    dbMock.update.mockResolvedValueOnce(true);
    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).resolves.toBe(true);
    expect(dbMock.update.mock.calls[0]).toEqual([
      'UPDATE `mica_blabber` SET `status` = ? WHERE `id` = ?',
      ['moderated', 11]
    ]);
  });
});
