// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { mail } from '../services/Mail';

/**
 * The mailbox shows everything not deleted, archived mail included — and, since MICA-428, never
 * what a purge erased or a window expired: those rows are kept for staff and shown to nobody,
 * their owner included. The read used to ask only `!= 'deleted'`, which would have handed a
 * player who deleted their data every erased letter back.
 */
describe('the mailbox read (MICA-428)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.query.mockResolvedValue([]);
  });

  it('leaves out deleted, erased and expired mail, and nothing else', async () => {
    const repo = mail.repo as unknown as { findAllByCitizenId(c: string): Promise<unknown[]> };
    await repo.findAllByCitizenId('CIT_A');

    const [sql, params] = dbMock.query.mock.calls[0];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain(
      "WHERE `citizenid` = ? AND `status` NOT IN ('deleted', 'erased', 'expired')"
    );
    // The positive twin: archived mail still shows, so the read names no other status.
    expect(flat).not.toMatch(/'archived'|'active'/);
    expect(params).toEqual(['CIT_A']);
  });
});

/**
 * MICA-428 review (Gregor): `archive` and `markAsRead` named no status, so unarchiving an erased
 * letter wrote `active` over `erased` and gave it back to the player who deleted everything. A
 * stub that applies each statement as MariaDB would: a `status IN (…)` in the `WHERE` narrows
 * it, and a statement without one moves any row.
 */
describe('archiving and reading touch only mail the inbox shows (MICA-428 review)', () => {
  let row: { id: number; citizenid: string; status: string; read: number };
  const repo = () =>
    mail.repo as unknown as {
      archive(id: number, citizenid: string, archive?: boolean): Promise<boolean>;
      markAsRead(id: number, citizenid: string): Promise<boolean>;
    };

  beforeEach(() => {
    row = { id: 1, citizenid: 'CIT_A', status: 'erased', read: 0 };
    dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
      const text = String(sql);
      const allowed = /`status` IN \(([^)]*)\)/.exec(text)?.[1];
      if (allowed && !allowed.includes(`'${row.status}'`)) return false;
      if (text.includes('SET `status` = ?')) row.status = String(params[0]);
      if (text.includes('SET `read` = 1')) row.read = 1;
      return true;
    });
  });

  for (const hidden of ['erased', 'expired', 'moderated', 'deleted']) {
    it(`never unarchives or reads a ${hidden} letter back`, async () => {
      row.status = hidden;
      expect(await repo().archive(1, 'CIT_A', false)).toBe(false);
      expect(await repo().archive(1, 'CIT_A', true)).toBe(false);
      expect(await repo().markAsRead(1, 'CIT_A')).toBe(false);
      expect(row).toMatchObject({ status: hidden, read: 0 });
    });
  }

  it('archives, unarchives and reads a letter the inbox shows — the positive twin', async () => {
    row.status = 'active';
    expect(await repo().archive(1, 'CIT_A', true)).toBe(true);
    expect(row.status).toBe('archived');
    expect(await repo().archive(1, 'CIT_A', false)).toBe(true);
    expect(row.status).toBe('active');
    expect(await repo().markAsRead(1, 'CIT_A')).toBe(true);
    expect(row.read).toBe(1);
  });
});
