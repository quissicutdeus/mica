// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { __setLogSaltForTests, loadLogSalt, who } from '../lib/who';

/**
 * `who()`: a short stable token for a citizenid or a number in a log line (MICA-433).
 */

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);
const bytes = (hex: string) =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

beforeEach(() => {
  vi.clearAllMocks();
  __setLogSaltForTests(null);
});

describe('who', () => {
  it('is short, stable for one id, different for another, and gives the id nothing back', () => {
    __setLogSaltForTests(bytes(SALT_A));
    const token = who('CID_A');
    expect(token).toMatch(/^[0-9a-f]{10}$/);
    expect(who('CID_A')).toBe(token);
    expect(who(' CID_A ')).toBe(token);
    expect(who('CID_B')).not.toBe(token);
    expect(token).not.toContain('CID');
  });

  it('depends on the install salt, so another install cannot match it', () => {
    __setLogSaltForTests(bytes(SALT_A));
    const a = who('CID_A');
    __setLogSaltForTests(bytes(SALT_B));
    expect(who('CID_A')).not.toBe(a);
  });

  it("marks a token taken before the install salt is read with '~'", () => {
    expect(who('CID_A')).toMatch(/^~[0-9a-f]{10}$/);
    expect(who('CID_A')).toBe(who('CID_A'));
  });

  it('reads nothing as nobody', () => {
    expect(who('')).toBe('-');
    expect(who(undefined)).toBe('-');
    expect(who(null)).toBe('-');
  });

  it('takes a number too', () => {
    __setLogSaltForTests(bytes(SALT_A));
    expect(who(5550101)).toBe(who('5550101'));
  });
});

describe('loadLogSalt', () => {
  it('reads the install salt from the ledger, the same one every start', async () => {
    dbMock.query.mockResolvedValue([{ id: `log-salt:${SALT_A}` }]);
    await loadLogSalt();
    const first = who('CID_A');
    __setLogSaltForTests(null);
    await loadLogSalt();
    expect(who('CID_A')).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{10}$/);
    expect(dbMock.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT'),
      expect.anything()
    );
  });

  it('mints one on first start, then reads back whichever the ledger kept', async () => {
    dbMock.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ id: `log-salt:${SALT_B}` }]);
    await loadLogSalt();

    const insert = dbMock.query.mock.calls[1];
    // Only while no salt exists, in one statement, so two first starts are serialised.
    expect(String(insert[0])).toBe(
      'INSERT INTO `mica_schema_migrations` (`id`) SELECT ? FROM DUAL WHERE NOT EXISTS ' +
        '(SELECT 1 FROM `mica_schema_migrations` WHERE `id` LIKE ?)'
    );
    expect(String(insert[1][0])).toMatch(/^log-salt:[0-9a-f]{64}$/);
    expect(insert[1][1]).toBe('log-salt:%');
    // Read back by when it was written, so every server takes the same row.
    expect(String(dbMock.query.mock.calls[2][0])).toContain('ORDER BY `applied_at`, `id`');
    // A racing start's salt, read back, is the one used — so both servers agree.
    __setLogSaltForTests(bytes(SALT_B));
    const expected = who('CID_A');
    __setLogSaltForTests(null);
    dbMock.query.mockResolvedValue([{ id: `log-salt:${SALT_B}` }]);
    await loadLogSalt();
    expect(who('CID_A')).toBe(expected);
  });

  it('reads back the winner when its own mint loses the race', async () => {
    // The other server's conditional insert held the lock: this one is the deadlock victim.
    dbMock.query
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Deadlock found when trying to get lock'))
      .mockResolvedValueOnce([{ id: `log-salt:${SALT_A}` }]);
    await loadLogSalt();

    const used = who('CID_A');
    __setLogSaltForTests(bytes(SALT_A));
    expect(used).toBe(who('CID_A'));
  });

  it('keeps the per-process salt, and says why without the query, when the ledger fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.query.mockRejectedValue(
      new Error('mica was unable to execute a query!\nSELECT …\n["log-salt:%"]\nLost connection')
    );
    await loadLogSalt();
    expect(who('CID_A')).toMatch(/^~/);
    expect(String(warn.mock.calls[0][0])).toContain('Lost connection');
    expect(String(warn.mock.calls[0][0])).not.toContain('SELECT');
    warn.mockRestore();
  });
});
