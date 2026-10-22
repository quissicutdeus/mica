// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * The in-server suite computes the token micaOS prints for a citizenid (MICA-433) with a reader
 * of its own, `integration/lib/logToken.ts`, so a scenario waits for the line about its own
 * fixture. Held here to the real `who()`, so the two cannot drift apart unnoticed.
 */
const { dbMock, integrationDb } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  integrationDb: { rows: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../../integration/lib/db', () => ({ db: integrationDb }));

import { __setLogSaltForTests, who } from '../lib/who';
import { installSaltHex, serverWho, tokenUnder } from '../../integration/lib/logToken';

const SALT = randomBytes(32).toString('hex');

beforeEach(() => {
  __setLogSaltForTests(Buffer.from(SALT, 'hex'));
});

afterEach(() => {
  __setLogSaltForTests(null);
  vi.clearAllMocks();
});

describe("the integration suite's log token", () => {
  it('is the token who() prints, for a citizenid, a licence and a number', () => {
    for (const value of ['ABC12345', 'char1:3f9a2c7e5b1d4f60a8c2e9b7d1f3a5c7e9b1d3f5', '5550101']) {
      expect(tokenUnder(SALT, value)).toBe(who(value));
    }
    // The positive twin's negative: under another salt it is not.
    expect(tokenUnder(randomBytes(32).toString('hex'), 'ABC12345')).not.toBe(who('ABC12345'));
  });

  it('reads the salt the server reads: the first well-formed row, in the order asked', async () => {
    integrationDb.rows.mockResolvedValue([{ id: 'log-salt:not-hex' }, { id: `log-salt:${SALT}` }]);
    expect(await installSaltHex()).toBe(SALT);
    expect(await serverWho('ABC12345')).toBe(who('ABC12345'));
    const [sql, params] = integrationDb.rows.mock.calls[0];
    expect(String(sql)).toContain('ORDER BY `applied_at`, `id`');
    expect(params).toEqual(['log-salt:%']);
  });

  it('refuses to guess when no salt was minted', async () => {
    integrationDb.rows.mockResolvedValue([]);
    await expect(installSaltHex()).rejects.toThrow(/never minted/);
  });
});
