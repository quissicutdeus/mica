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
      'UPDATE `mica_blabber` SET `status` = ? WHERE `id` = ? AND `status` = ?\n' +
      '["moderated",11,"deleted"]\n' +
      "Duplicate entry '1-9' for key 'mica_blabber.account_mouth_key'"
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.insert.mockResolvedValue(1);
  // The row a takedown reads before it writes: deleted by its author (MICA-330's case).
  dbMock.single.mockResolvedValue({ status: 'deleted' });
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

    const error = (await restoreTarget(
      'mica_blabber',
      11,
      'active',
      'ADMIN',
      'report #3 reopened'
    ).catch((e: unknown) => e)) as PlayerFacingError & { cause?: unknown };

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

  it('still moderates when nothing collides, and answers the status it replaced', async () => {
    dbMock.update.mockResolvedValueOnce(true);
    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).resolves.toBe('deleted');
    expect(dbMock.update.mock.calls[0]).toEqual([
      'UPDATE `mica_blabber` SET `status` = ? WHERE `id` = ? AND `status` = ?',
      ['moderated', 11, 'deleted']
    ]);
  });
});

/**
 * The status a takedown replaced, and putting exactly that back (MICA-386). The round trip
 * through the report is `moderationRestore.test.ts`; this is the primitive's own contract.
 */
describe('what a takedown replaced, and what a restore writes (MICA-386)', () => {
  it('re-reads a row whose status moved between its read and its write', async () => {
    // Read live, then the author deletes before the write lands: the swap matches nothing,
    // and the answer is the status the takedown actually replaced.
    dbMock.single.mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({
      status: 'deleted'
    });
    dbMock.update.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).resolves.toBe('deleted');
    expect(dbMock.update.mock.calls.map(([, params]) => params)).toEqual([
      ['moderated', 11, 'active'],
      ['moderated', 11, 'deleted']
    ]);
  });

  it('gives up loudly on a row that never holds still, and audits nothing', async () => {
    dbMock.single.mockResolvedValue({ status: 'active' });
    dbMock.update.mockResolvedValue(false);

    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).rejects.toThrow(/kept changing/);
    expect(dbMock.update).toHaveBeenCalledTimes(3);
    const audited = dbMock.insert.mock.calls.some(([sql]) => /mica_audit_logs/.test(String(sql)));
    expect(audited).toBe(false);
  });

  it('answers null for a row that is gone, and writes nothing', async () => {
    dbMock.single.mockResolvedValue(null);
    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).resolves.toBeNull();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('leaves a row already moderated alone, answers so, and still audits the decision', async () => {
    dbMock.single.mockResolvedValue({ status: 'moderated' });
    await expect(moderateTarget('mica_blabber', 11, 'ADMIN', 'r')).resolves.toBe('moderated');
    expect(dbMock.update).not.toHaveBeenCalled();
    const audited = dbMock.insert.mock.calls.some(([sql]) => /mica_audit_logs/.test(String(sql)));
    expect(audited).toBe(true);
  });

  it('restores the status it is given, and only over a row still moderated', async () => {
    dbMock.update.mockResolvedValueOnce(true);
    await expect(restoreTarget('mica_blabber', 11, 'deleted', 'ADMIN', 'r')).resolves.toBe(true);
    expect(dbMock.update.mock.calls[0]).toEqual([
      'UPDATE `mica_blabber` SET `status` = ? WHERE `id` = ? AND `status` = ?',
      ['deleted', 11, 'moderated']
    ]);
  });

  it('writes nothing, and audits nothing, over a row no longer moderated', async () => {
    dbMock.update.mockResolvedValueOnce(false);
    await expect(restoreTarget('mica_blabber', 11, 'active', 'ADMIN', 'r')).resolves.toBe(false);
    const audited = dbMock.insert.mock.calls.some(([sql]) => /mica_audit_logs/.test(String(sql)));
    expect(audited).toBe(false);
  });

  it.each(['moderated', '', 'Active', "active' OR 1=1", 'x'.repeat(33)])(
    'refuses to restore to %j, before any statement',
    async (status) => {
      await expect(restoreTarget('mica_blabber', 11, status, 'ADMIN', 'r')).rejects.toThrow(
        /refusing to restore/
      );
      expect(dbMock.update).not.toHaveBeenCalled();
    }
  );
});
