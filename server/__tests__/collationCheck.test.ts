// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

// Real declarations, the same way `generatedSchema.test.ts` populates `declaredServices` —
// `liveGphoneCollation` needs at least one real table name to query against.
import '../services/index';
import { checkOwnerCollation, collationMismatchMessage } from '../lib/collationCheck';

/**
 * MICA-157. `mica.sql` declares every table `COLLATE = utf8mb4_unicode_ci`, and most of
 * them carry a foreign key onto the framework's `players(citizenid)`. A foreign key requires
 * both sides to share a collation; MariaDB 11.4+ changed its own `utf8mb4` default away from
 * this one, so an operator who created `players` without an explicit collation on a modern
 * MariaDB gets a raw-SQL import that fails partway through with an opaque MySQL errno 150 —
 * naming neither collation nor `players`. This is the detection half: `micaschema apply`
 * asks `checkOwnerCollation` before running any DDL of its own, so the same underlying
 * mismatch is reported with the actual table and both actual collations instead.
 */
describe('checkOwnerCollation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockSchema = (schema: string | null) => dbMock.scalar.mockResolvedValueOnce(schema);

  it('fails loud, naming the table and both collations, on a real mismatch', async () => {
    mockSchema('mica_db');
    // players.citizenid
    dbMock.scalar.mockResolvedValueOnce('utf8mb4_uca1400_ai_ci');
    // no micaOS table exists yet (a fully-failed fresh import) — falls back to the
    // generated file's own known collation.
    dbMock.scalar.mockResolvedValueOnce(null);

    const mismatch = await checkOwnerCollation();

    expect(mismatch).toEqual({
      ownerTable: 'players',
      ownerColumn: 'citizenid',
      ownerCollation: 'utf8mb4_uca1400_ai_ci',
      expectedCollation: 'utf8mb4_unicode_ci',
      constraint: 'foreign-key'
    });
    const message = collationMismatchMessage(mismatch!);
    expect(message).toContain('`players`.`citizenid`');
    expect(message).toContain('utf8mb4_uca1400_ai_ci');
    expect(message).toContain('utf8mb4_unicode_ci');
    expect(message).toContain('errno 150');
    expect(message).not.toContain('errno 1267');
    expect(dbMock.scalar).toHaveBeenCalledTimes(3);
    expect(dbMock.scalar.mock.calls[1][1]).toEqual(['mica_db', 'players', 'citizenid']);
  });

  it("prefers an already-created micaOS table's live collation over the generated default", async () => {
    mockSchema('mica_db');
    dbMock.scalar.mockResolvedValueOnce('utf8mb4_uca1400_ai_ci'); // players
    dbMock.scalar.mockResolvedValueOnce('utf8mb4_uca1400_ai_ci'); // a live micaOS table, same

    const mismatch = await checkOwnerCollation();

    // Both sides actually agree once the live micaOS collation is used instead of the
    // hardcoded default — this is the case a hand-edited live table would produce, and it
    // must not be reported as a mismatch against a value nothing on this database has.
    expect(mismatch).toBeNull();
  });

  it('reports no mismatch when the collations already agree', async () => {
    mockSchema('mica_db');
    dbMock.scalar.mockResolvedValueOnce('utf8mb4_unicode_ci'); // players
    dbMock.scalar.mockResolvedValueOnce(null); // no micaOS table yet, falls back to default

    expect(await checkOwnerCollation()).toBeNull();
  });

  /**
   * MICA-200 checked `users.identifier` on ESX, because a column-to-column join onto it is
   * errno 1267 when its collation differs. MICA-299 made the one such join, the orphan sweep,
   * compare in the owner's own collation, so nothing a mismatch there breaks remains — and
   * refusing on it refused `micaschema apply` on every stock ESX install on MariaDB 11.4+.
   */
  describe('on ESX, where the owner column is users.identifier', () => {
    it('does not refuse apply over a users.identifier collation, and never asks about it', async () => {
      mockSchema('mica_db');
      dbMock.scalar.mockResolvedValueOnce(null); // no players.citizenid
      // What `users.identifier` would answer on stock ESX + MariaDB 11.4, if it were asked.
      dbMock.scalar.mockResolvedValue('utf8mb4_uca1400_ai_ci');

      expect(await checkOwnerCollation()).toBeNull();
      expect(dbMock.scalar).toHaveBeenCalledTimes(2);
      for (const call of dbMock.scalar.mock.calls) {
        expect(call[1] ?? []).not.toContain('users');
      }
    });
  });

  it('has nothing to check when players.citizenid does not exist', async () => {
    mockSchema('mica_db');
    dbMock.scalar.mockResolvedValueOnce(null); // no players.citizenid

    expect(await checkOwnerCollation()).toBeNull();
    // The owner probe, and nothing after — no micaOS collation is worth reading when there
    // is nothing to compare it against.
    expect(dbMock.scalar).toHaveBeenCalledTimes(2);
  });

  it('has nothing to check when the current schema cannot be determined', async () => {
    mockSchema(null);

    expect(await checkOwnerCollation()).toBeNull();
    // Only the `SELECT DATABASE()` call — no point in querying information_schema for a
    // schema that could not be named.
    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
  });
});
