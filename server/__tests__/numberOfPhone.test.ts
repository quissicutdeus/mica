// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbCall } from './dbMockTypes';

/**
 * MICA-346: the number a phone shows when it calls, texts or shares a location.
 *
 * On qb and standalone the framework's number is the number of the phone the last sync settled.
 * For a player who has just picked up a burner with no number row, that is their main phone. A
 * call or text from the burner showed it until the sync landed, and for good if assignment gave
 * up. `numberOfPhone` answers only from rows keyed by this phone, or the citizen's legacy row
 * read after the sync, and otherwise null.
 *
 * The two tables are in-memory maps here; `Database` is mocked because it reads
 * `exports.oxmysql` in module scope (AGENTS.md §1). Nothing here executes SQL.
 */
const { dbMock, tables } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn<DbCall>()
  },
  tables: {
    /** A phone id to the number on that phone. */
    onPhone: new Map<string, string>(),
    /** A citizenid to their legacy number, the row with `device_id IS NULL`. */
    legacy: new Map<string, string>()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { numberOfPhone, type NumberSources } from '../lib/phoneNumbers';

const BURNER = 'b'.repeat(32);
const MAIN = 'a'.repeat(32);
/** Holding the burner. `phone` is what the framework answers: the main phone's number. */
const holder = { source: 5, citizenid: 'CIT_A', phone: '5550100' };

const row = (citizenid: string, number: string) => ({ id: 1, citizenid, number, status: 'active' });

beforeEach(() => {
  tables.onPhone.clear();
  tables.legacy.clear();
  tables.onPhone.set(MAIN, '5550100');
  dbMock.single.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
    const key = String(params?.[0]);
    if (/`device_id` IS NULL/.test(sql)) {
      const number = tables.legacy.get(key);
      return number ? row(key, number) : null;
    }
    if (/WHERE `device_id` = \?/.test(sql)) {
      const number = tables.onPhone.get(key);
      return number ? row('CIT_A', number) : null;
    }
    throw new Error(`unexpected single(): ${sql}`);
  });
});

/** A sync that does `effect` and then answers what the sync answers: some phone's number. */
const sources = (
  framework: NumberSources['framework'],
  effect: () => void = () => {},
  answer: string | null = null
): NumberSources & { sync: ReturnType<typeof vi.fn> } => ({
  framework,
  sync: vi.fn(async () => {
    effect();
    return answer;
  })
});

describe('numberOfPhone (MICA-346)', () => {
  describe.each(['qb', 'standalone'] as const)('%s', (framework) => {
    it('answers the phone’s own row, and asks no sync for it', async () => {
      tables.onPhone.set(BURNER, '5550777');
      const how = sources(framework);

      await expect(numberOfPhone(BURNER, holder, how)).resolves.toBe('5550777');
      expect(how.sync).not.toHaveBeenCalled();
    });

    it('answers null, never the main number, for a burner the sync wrote no row for', async () => {
      // The sync it joins is still settling the main phone, and answers that phone's number.
      const how = sources(framework, () => {}, '5550100');

      await expect(numberOfPhone(BURNER, holder, how)).resolves.toBeNull();
      expect(how.sync).toHaveBeenCalledWith(5);
    });

    it('answers the row the sync writes for the burner', async () => {
      const how = sources(framework, () => tables.onPhone.set(BURNER, '5550777'), '5550777');

      await expect(numberOfPhone(BURNER, holder, how)).resolves.toBe('5550777');
    });

    it('answers the legacy number of a phone that cannot carry an id of its own', async () => {
      tables.legacy.set('CIT_A', '5550133');

      await expect(numberOfPhone(BURNER, holder, sources(framework))).resolves.toBe('5550133');
    });

    it('reads the legacy row after the sync, so one it attaches to another phone is not used', async () => {
      // The citizen's first-ever load: their number is still a legacy row while the sync for
      // the main phone attaches it there. Read before that sync, it would name the main phone.
      tables.onPhone.delete(MAIN);
      tables.legacy.set('CIT_A', '5550100');
      const attachToMain = sources(framework, () => {
        tables.legacy.delete('CIT_A');
        tables.onPhone.set(MAIN, '5550100');
      });

      await expect(numberOfPhone(BURNER, holder, attachToMain)).resolves.toBeNull();

      // The twin: the same sync attaching the legacy row to the burner, the phone in hand.
      tables.onPhone.delete(MAIN);
      tables.legacy.set('CIT_A', '5550100');
      const attachToBurner = sources(framework, () => {
        tables.legacy.delete('CIT_A');
        tables.onPhone.set(BURNER, '5550100');
      });

      await expect(numberOfPhone(BURNER, holder, attachToBurner)).resolves.toBe('5550100');
    });

    it('goes on without a sync that rejects, and logs it', async () => {
      tables.legacy.set('CIT_A', '5550133');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const how: NumberSources = {
          framework,
          sync: async () => {
            throw new Error('could not read which device');
          }
        };

        await expect(numberOfPhone(BURNER, holder, how)).resolves.toBe('5550133');
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe('esx', () => {
    it("answers the framework's number, which is the character's, with no read and no sync", async () => {
      const how = sources('esx');

      await expect(numberOfPhone(BURNER, holder, how)).resolves.toBe('5550100');
      expect(dbMock.single).not.toHaveBeenCalled();
      expect(how.sync).not.toHaveBeenCalled();
    });

    it('answers null for a character the framework has no number for', async () => {
      await expect(
        numberOfPhone(BURNER, { ...holder, phone: undefined }, sources('esx'))
      ).resolves.toBeNull();
    });
  });
});
