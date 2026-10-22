// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
import {
  contentContext,
  encryptedColumn,
  openContent,
  registerEncryptedColumn,
  resetContentCipherForTests,
  sealRow,
  sealedKeyId,
  unregisterEncryptedColumnForTests
} from '../lib/contentCipher';

/**
 * `micaseed` writes and deletes rows in tables the framework owns, on a live server,
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
    // The defect: `DELETE FROM mica_contacts WHERE phone IN (...)` and nothing else,
    // so a player who had saved 5550101 themselves lost it whenever an admin ran
    // `micaseed clear`. A contact row carries no marker saying the seed wrote it, so
    // the delete has to match everything the seed would have written. Since MICA-431 the
    // name is sealed, so it is matched after the rows are read and opened, and deleted by id.
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).startsWith('SELECT id, citizenid, device_id, firstname, lastname')
        ? contactsOn(String(params[0]))
        : []
    );

    await clearSeed();

    const reads = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('FROM mica_contacts WHERE phone = ?')
    );
    expect(reads.map((c) => c[1][0]).toSorted()).toEqual(
      SEED_CHARACTERS.map((c) => c.phone).toSorted()
    );
    const contactDeletes = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('DELETE FROM mica_contacts')
    );
    for (const [sql] of contactDeletes) {
      // No name in SQL: it is sealed, and a comparison there would match nothing.
      expect(String(sql)).not.toMatch(/firstname|lastname/);
      expect(String(sql)).toContain('WHERE id IN');
    }
    // The seed's rows and only those: the player's own contact on the same number stays.
    const deleted = contactDeletes.flatMap((c) => c[1] as number[]).toSorted((a, b) => a - b);
    expect(deleted).toEqual(SEED_CHARACTERS.map((_, i) => 100 + i));
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
    expect(params[0]).toBe('license:micaseed');
    expect(params.slice(1).toSorted()).toEqual(SEED_CHARACTERS.map((c) => c.citizenid).toSorted());
  });

  it('deletes conversation children before their parent', async () => {
    // Both child tables carry a foreign key onto the conversation, so the order is not
    // cosmetic — reversing it fails on the constraint and leaves the seed half-removed.
    dbMock.query.mockResolvedValueOnce([{ conversation_id: 7 }]);
    await clearSeed();

    const order = queries();
    const messages = order.findIndex((q) => q.includes('DELETE FROM mica_messages WHERE'));
    const participants = order.findIndex((q) => q.includes('mica_messages_participants'));
    const conversations = order.findIndex((q) =>
      q.includes('DELETE FROM mica_messages_conversations')
    );

    expect(messages).toBeGreaterThanOrEqual(0);
    expect(messages).toBeLessThan(conversations);
    expect(participants).toBeLessThan(conversations);
  });

  it('touches no conversation table when the seed has no threads', async () => {
    dbMock.query.mockResolvedValue([]);
    await clearSeed();

    expect(queries().some((q) => q.includes('DELETE FROM mica_messages_conversations'))).toBe(
      false
    );
  });
});

/**
 * On each seed number: the row the seed wrote (id 100 + i), and a player's own contact on the
 * same number under another name (id 200 + i).
 */
const contactsOn = (phone: string) => {
  const at = SEED_CHARACTERS.findIndex((c) => c.phone === phone);
  const character = SEED_CHARACTERS[at];
  return [
    {
      id: 100 + at,
      citizenid: 'REAL_PLAYER',
      device_id: null,
      firstname: character.firstname,
      lastname: character.lastname
    },
    {
      id: 200 + at,
      citizenid: 'REAL_PLAYER',
      device_id: 'PHONE1',
      firstname: 'Mom',
      lastname: null
    }
  ];
};

describe('seedFor', () => {
  it('scopes the contacts it creates to the player who asked', async () => {
    dbMock.query.mockResolvedValue([]);
    await seedFor('REAL_PLAYER');

    const inserts = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO mica_contacts')
    );
    expect(inserts.length).toBe(SEED_CHARACTERS.length);
    for (const [, params] of inserts) {
      expect(params[0]).toBe('REAL_PLAYER');
    }
  });

  it('does not create a contact the player already has', async () => {
    // Safe to run more than once is a documented promise of the command.
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('SELECT id FROM mica_contacts') ? [{ id: 1 }] : []
    );

    const result = await seedFor('REAL_PLAYER');

    expect(result.contacts).toBe(0);
    expect(
      dbMock.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO mica_contacts'))
    ).toBe(false);
  });
});

describe('MICA-165: seeded messages are sealed', () => {
  let dir = '';
  let registered = false;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-seed-key-'));
    const path = join(dir, 'content.key');
    writeFileSync(path, `seed ${randomBytes(32).toString('base64')}\n`);
    chmodSync(path, 0o600);
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_content_key_file' ? path : fallback;
    resetContentCipherForTests();
    registered = !encryptedColumn('mica_messages', 'message');
    if (registered) {
      registerEncryptedColumn({
        table: 'mica_messages',
        column: 'message',
        scope: ['conversation_id'],
        hasUpdatedAt: true
      });
      for (const column of ['firstname', 'lastname']) {
        registerEncryptedColumn({
          table: 'mica_contacts',
          column,
          scope: [],
          hasUpdatedAt: true,
          binding: 'device'
        });
      }
    }
  });

  afterEach(() => {
    if (registered) {
      unregisterEncryptedColumnForTests('mica_messages', 'message');
      unregisterEncryptedColumnForTests('mica_contacts', 'firstname');
      unregisterEncryptedColumnForTests('mica_contacts', 'lastname');
    }
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
    resetContentCipherForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts each opener sealed for its thread and sender', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('INSERT INTO mica_messages_conversations') ? { insertId: 41 } : []
    );

    await seedFor('REAL_PLAYER');

    const inserts = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO mica_messages (')
    );
    expect(inserts.length).toBeGreaterThan(0);
    const entry = encryptedColumn('mica_messages', 'message')!;
    for (const [, [conversation_id, citizenid, message]] of inserts) {
      expect(conversation_id).toBe(41);
      expect(sealedKeyId(message)).toBe('seed');
      const plain = openContent(contentContext(entry, { conversation_id, citizenid }), message);
      expect(Object.values(SEED_OPENERS).flat()).toContain(plain);
    }
    expect(inserts[0][1][1]).toBe('SEED0001');
  });

  it('inserts each seeded contact sealed to its owner, on no phone (MICA-431)', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('INSERT INTO mica_messages_conversations') ? { insertId: 41 } : []
    );

    await seedFor('REAL_PLAYER');

    const inserts = dbMock.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO mica_contacts')
    );
    expect(inserts).toHaveLength(SEED_CHARACTERS.length);
    const first = encryptedColumn('mica_contacts', 'firstname')!;
    for (const [, [owner, firstname, , phone]] of inserts) {
      expect(sealedKeyId(firstname)).toBe('seed');
      const named = SEED_CHARACTERS.find((c) => c.phone === phone)!;
      const context = contentContext(first, { citizenid: owner, device_id: null });
      expect(openContent(context, firstname)).toBe(named.firstname);
    }
  });

  it("clears the sealed seed contacts by their opened names, and not a player's own", async () => {
    const sealedOn = async (phone: string) =>
      await Promise.all(contactsOn(phone).map(async (row) => await sealRow('mica_contacts', row)));
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).startsWith('SELECT id, citizenid, device_id, firstname, lastname')
        ? await sealedOn(String(params[0]))
        : []
    );

    await clearSeed();

    const deleted = dbMock.query.mock.calls
      .filter((c) => String(c[0]).includes('DELETE FROM mica_contacts'))
      .flatMap((c) => c[1] as number[])
      .toSorted((a, b) => a - b);
    expect(deleted).toEqual(SEED_CHARACTERS.map((_, i) => 100 + i));
  });
});

/** `lib/seed.ts`'s openers, as the seeded characters send them. */
const SEED_OPENERS: Record<string, string[]> = {
  SEED0001: ['hey, you around?', 'got that thing sorted or not'],
  SEED0002: ['yo', 'meet me at the docks in 10'],
  SEED0003: ['wrong number sorry'],
  SEED0004: ['did you see what happened on vinewood?', 'wild']
};
