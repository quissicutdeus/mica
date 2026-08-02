import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { SEED_CHARACTERS, clearSeed, seedFor } from '../lib/seed';

/**
 * `gphoneseed` writes and deletes rows in tables the framework owns, on a live server,
 * from a console command an admin runs casually. It had no test at all.
 *
 * These assert the shape of the SQL rather than its effect, which is the most a unit
 * test can do without a database — but the thing that went wrong was the shape: a
 * `DELETE` that named the right table and not enough columns.
 */

const queries = () => dbMock.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());
const queryFor = (fragment: string) =>
  dbMock.query.mock.calls.find((c) => String(c[0]).replace(/\s+/g, ' ').includes(fragment));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('seed characters', () => {
  it('uses citizenids no real character could hold', () => {
    // The delete path is scoped by this list, so it is load-bearing that every entry is
    // obviously synthetic and that the list is a constant rather than a query.
    for (const character of SEED_CHARACTERS) {
      expect(character.citizenid).toMatch(/^SEED\d{4}$/);
    }
    expect(new Set(SEED_CHARACTERS.map((c) => c.citizenid)).size).toBe(SEED_CHARACTERS.length);
    expect(new Set(SEED_CHARACTERS.map((c) => c.phone)).size).toBe(SEED_CHARACTERS.length);
  });
});

describe('clearSeed', () => {
  it('never deletes a contact on a seed number that the seed did not write', async () => {
    // The defect: `DELETE FROM gphone_contacts WHERE phone IN (...)` and nothing else,
    // so a player who had saved 5550101 themselves lost it whenever an admin ran
    // `gphoneseed clear`. A contact row carries no marker saying the seed wrote it, so
    // the delete has to match everything the seed would have written.
    await clearSeed();

    const contactDeletes = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('DELETE FROM gphone_contacts')
    );
    expect(contactDeletes.length).toBe(SEED_CHARACTERS.length);

    for (const [sql, params] of contactDeletes) {
      const flat = String(sql).replace(/\s+/g, ' ');
      expect(flat).toContain('phone = ?');
      expect(flat).toContain('firstname = ?');
      expect(flat).toContain('lastname = ?');
      expect(params).toHaveLength(3);
    }

    // Every seed character accounted for, and nothing else.
    const phones = contactDeletes.map((c) => c[1][0]).sort();
    expect(phones).toEqual(SEED_CHARACTERS.map((c) => c.phone).sort());
  });

  it('requires the seed license as well as the seed ids before touching players', async () => {
    // The one delete that reaches the framework's own table. Two independent guards.
    await clearSeed();

    const call = queryFor('DELETE FROM players');
    expect(call, 'the players delete should still happen').toBeDefined();

    const [sql, params] = call!;
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain('license = ?');
    expect(flat).toContain('citizenid IN');
    expect(params[0]).toBe('license:gphoneseed');
    expect(params.slice(1).sort()).toEqual(SEED_CHARACTERS.map((c) => c.citizenid).sort());
  });

  it('deletes conversation children before their parent', async () => {
    // Both child tables carry a foreign key onto the conversation, so the order is not
    // cosmetic — reversing it fails on the constraint and leaves the seed half-removed.
    dbMock.query.mockResolvedValueOnce([{ conversation_id: 7 }]);
    await clearSeed();

    const order = queries();
    const messages = order.findIndex((q) => q.includes('DELETE FROM gphone_messages WHERE'));
    const participants = order.findIndex((q) => q.includes('gphone_messages_participants'));
    const conversations = order.findIndex((q) =>
      q.includes('DELETE FROM gphone_messages_conversations')
    );

    expect(messages).toBeGreaterThanOrEqual(0);
    expect(messages).toBeLessThan(conversations);
    expect(participants).toBeLessThan(conversations);
  });

  it('touches no conversation table when the seed has no threads', async () => {
    dbMock.query.mockResolvedValue([]);
    await clearSeed();

    expect(queries().some((q) => q.includes('DELETE FROM gphone_messages_conversations'))).toBe(
      false
    );
  });
});

describe('seedFor', () => {
  it('scopes the contacts it creates to the player who asked', async () => {
    dbMock.query.mockResolvedValue([]);
    await seedFor('REAL_PLAYER');

    const inserts = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO gphone_contacts')
    );
    expect(inserts.length).toBe(SEED_CHARACTERS.length);
    for (const [, params] of inserts) {
      expect(params[0]).toBe('REAL_PLAYER');
    }
  });

  it('does not create a contact the player already has', async () => {
    // Safe to run more than once is a documented promise of the command.
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('SELECT id FROM gphone_contacts') ? [{ id: 1 }] : []
    );

    const result = await seedFor('REAL_PLAYER');

    expect(result.contacts).toBe(0);
    expect(
      dbMock.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO gphone_contacts'))
    ).toBe(false);
  });
});
