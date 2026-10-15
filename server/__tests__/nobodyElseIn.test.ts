// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-349: `nobodyElseIn` asks whether a text into this thread would reach nobody.
 *
 * The statement is a NOT EXISTS over the membership table that no unit suite can execute; the
 * real answer against MariaDB is `test:endpoints`' leftThread flow. What this holds is the
 * statement's shape: which threads it can ever answer yes for, that the pair columns are
 * NULL-safe (an unpaired thread holds NULL in both), that the other member is any phone but
 * this one, null-safely, and that only the named column means yes, so a stub answering every
 * `single` with a row refuses nothing.
 */
vi.mock('../lib/Database', () => ({
  Database: {
    single: vi.fn(async () => null),
    query: vi.fn(async () => []),
    insert: vi.fn(async () => 1),
    update: vi.fn(async () => true),
    scalar: vi.fn(async () => null)
  }
}));

import { Database } from '../lib/Database';
import { conversations } from '../services/Conversations';
import type { ConversationRepository } from '../repositories/ConversationRepository';

const repo = conversations.repo as ConversationRepository;
const PHONE = 'b'.repeat(32);

beforeEach(() => {
  vi.mocked(Database.single).mockReset();
  vi.mocked(Database.single).mockResolvedValue(null);
});

describe('nobodyElseIn is a 1:1 with nobody else live in it (MICA-349)', () => {
  it('says yes only when the row carries the named column', async () => {
    vi.mocked(Database.single).mockResolvedValueOnce({ nobody_else: 1 });
    expect(await repo.nobodyElseIn(7, PHONE)).toBe(true);

    // The positive twin's negatives: no row, and a row that is not this answer.
    vi.mocked(Database.single).mockResolvedValueOnce(null);
    expect(await repo.nobodyElseIn(7, PHONE)).toBe(false);
    vi.mocked(Database.single).mockResolvedValueOnce({ 1: 1 });
    expect(await repo.nobodyElseIn(7, PHONE)).toBe(false);
  });

  it('never answers for a group, a line thread or a thread no longer active', async () => {
    await repo.nobodyElseIn(7, PHONE);

    expect(Database.single).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(Database.single).mock.calls[0];
    const where = String(sql).replace(/\s+/g, ' ');
    expect(where).toContain("WHERE c.id = ? AND c.is_group = 0 AND c.status = 'active'");
    // COALESCE: `NULL NOT LIKE` is NULL, which would drop every unpaired thread.
    expect(where).toContain(
      "AND COALESCE(c.participant_a, '') NOT LIKE ? AND COALESCE(c.participant_b, '') NOT LIKE ?"
    );
    expect(params).toEqual([7, 'ext:%', 'ext:%', PHONE]);
  });

  it('counts any live member on another phone, a legacy row with none included', async () => {
    await repo.nobodyElseIn(7, PHONE);

    const where = String(vi.mocked(Database.single).mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(where).toContain(
      'AND NOT EXISTS ( SELECT 1 FROM mica_messages_participants p ' +
        'WHERE p.conversation_id = c.id AND p.left_at IS NULL AND NOT (p.device_id <=> ?) )'
    );
  });

  it('asks nothing without a phone', async () => {
    expect(await repo.nobodyElseIn(7, '')).toBe(false);
    expect(Database.single).not.toHaveBeenCalled();
  });
});
