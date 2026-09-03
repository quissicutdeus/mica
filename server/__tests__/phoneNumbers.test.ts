// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-151: the numbers gOS issues when nothing else will.
 *
 * On qb the number is `charinfo.phone` and on ESX it is whichever field the operator's
 * community resource writes. A standalone server has neither, and without a number
 * `getPlayerByPhone`, dialling and `conversations:create` resolve nobody — so Phone, Messages
 * and Contacts do not work at all. This is the table that fixes that, and the properties
 * asserted below are the four that make a phone number usable: stable, unique, in the format
 * the rest of the repo already uses, and clear of the block `gosseed` owns.
 *
 * `Database` is mocked because it reads `exports.oxmysql` in module scope and must never
 * reach a real connection (AGENTS.md §1). Nothing here executes SQL, so nothing here proves
 * the unique keys exist — `generatedSchema.test.ts` holds the committed DDL to the
 * declaration, and only a real import proves the DDL is valid.
 */
const { dbMock, framework, subscribers } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  },
  framework: { kind: 'standalone' as string },
  /**
   * What `onPlayerLoaded` was handed at import.
   *
   * `lib/shell.ts` is mocked rather than imported so this suite drives the subscriber
   * directly, without registering the real `playerJoining` listener or dragging the orphan
   * sweep in behind it. `playerLoaded.test.ts` is what proves the registry and its entry
   * points behave; this only needs the one subscriber this service adds.
   */
  subscribers: [] as { name: string; run: (src: number) => unknown }[]
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/shell', () => ({
  onPlayerLoaded: (name: string, run: (src: number) => unknown) => {
    subscribers.push({ name, run });
  }
}));
vi.mock('../lib/FrameworkBridge', () => ({
  detectFramework: () => framework.kind,
  FrameworkBridge: {
    getCitizenId: (src: number) => (src === 5 ? CITIZEN : null),
    getPlayer: () => null,
    getAllPlayers: () => ({}),
    registerUsableItem: () => {}
  }
}));

import {
  generatePhoneNumber,
  isDuplicateEntry,
  numberFor,
  readCitizenIdByNumber,
  readNumber,
  rememberNumber,
  MAX_ASSIGN_ATTEMPTS,
  PHONE_NUMBERS_TABLE,
  __resetAssignedNumbers
} from '../lib/phoneNumbers';
import { ensureNumber, phoneNumbers } from '../services/PhoneNumbers';

const CITIZEN = `license:${'a'.repeat(40)}`;
const OTHER = `license:${'b'.repeat(40)}`;

/** The unique-key violation MySQL raises, as mysql2 shapes it. */
const duplicate = () =>
  Object.assign(new Error("Duplicate entry '5561234' for key 'number'"), {
    errno: 1062,
    code: 'ER_DUP_ENTRY'
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetAssignedNumbers();
  framework.kind = 'standalone';
  dbMock.single.mockResolvedValue(null);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
});

/** A row as `readAssignedRow` selects it. */
const row = (number: string, status = 'active') => ({ id: 42, number, status });

describe('the generated number', () => {
  const draws = (samples: number): string[] =>
    Array.from({ length: samples }, () => generatePhoneNumber());

  it('is seven digits, like every number already in the repo', () => {
    // `lib/seed.ts` writes 5550101–5550104, and `netGuard.phoneNumberFrom` only trims and
    // caps at 32 characters — it will not normalise a format mismatch away.
    for (const number of draws(500)) expect(number).toMatch(/^\d{7}$/);
  });

  it('never lands in the exchange `gosseed` owns', () => {
    // `clearSeed` deletes contacts by phone together with the seeded name, so a real player
    // issued 5550101 and saved under the matching name would lose that contact to an admin
    // tidying up after the seed. The whole 555 block is reserved, not just the four literals,
    // so the seed can grow without anybody remembering this file exists.
    for (const number of draws(2000)) {
      expect(Number(number) < 5550000 || Number(number) > 5559999).toBe(true);
    }
  });

  it('covers the space right up to both of its edges, and no further', () => {
    // The reserved block is skipped arithmetically rather than by drawing again, so these are
    // exact rather than statistical. A reject-and-retry loop would hang on a `random` that
    // always landed in the block — a stub, or a broken injection — with nothing in the log.
    expect(generatePhoneNumber(() => 0)).toBe('2000000');
    expect(generatePhoneNumber(() => 0.9999999999)).toBe('9999999');
  });

  it('steps straight over the reserved block rather than into it', () => {
    // The two draws either side of the seam. 5549999 is the last number below it; the very
    // next index has to be 5560000, not 5550000.
    const SPACE = 9999999 - 2000000 + 1 - 10000;
    const draw = (index: number) => generatePhoneNumber(() => (index + 0.5) / SPACE);

    expect(draw(5549999 - 2000000)).toBe('5549999');
    expect(draw(5549999 - 2000000 + 1)).toBe('5560000');
  });

  it('is not derived from the citizenid', () => {
    // A derived number leaks the license identifier's entropy into a string other players are
    // shown, and hands the same player the same number on every server running gOS.
    const many = new Set(draws(200));

    expect(many.size).toBeGreaterThan(150);
  });

  it('survives a random source that answers out of range', () => {
    expect(generatePhoneNumber(() => -1)).toMatch(/^\d{7}$/);
    expect(generatePhoneNumber(() => 2)).toMatch(/^\d{7}$/);
  });
});

describe('telling a duplicate key from a real failure', () => {
  // The two demand opposite responses: a duplicate means try another number, anything else
  // means stop and say so. A loop that retried both would turn "the table was never imported"
  // into eight identical failures and then a misleading "the space is exhausted".
  it.each([
    ['mysql2 errno', duplicate()],
    ['a bare string from the driver', "Duplicate entry '5561234' for key 'number_unique'"],
    ['a message with nothing else on it', new Error('Duplicate entry for key citizenid_unique')],
    ['a code with no errno', Object.assign(new Error('nope'), { code: 'er_dup_entry' })]
  ])('recognises %s', (_label, error) => {
    expect(isDuplicateEntry(error)).toBe(true);
  });

  it.each([
    ['a table that was never imported', new Error("Table 'gos_phone_numbers' doesn't exist")],
    ['a dead connection', Object.assign(new Error('ECONNREFUSED'), { errno: -111 })],
    ['nothing at all', undefined],
    ['null', null]
  ])('does not mistake %s for one', (_label, error) => {
    expect(isDuplicateEntry(error)).toBe(false);
  });
});

describe('assigning a number', () => {
  it('issues one and remembers it, so the synchronous bridge can read it', () => {
    return ensureNumber(CITIZEN).then((number) => {
      expect(number).toMatch(/^\d{7}$/);
      expect(numberFor(CITIZEN)).toBe(number);
      expect(dbMock.insert).toHaveBeenCalledTimes(1);
      expect(String(dbMock.insert.mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
    });
  });

  it('never issues a second one to a player who already has theirs', async () => {
    // A reconnecting player keeps their number, or every contact anybody saved for them
    // points at somebody else. That is what makes this a table rather than a runtime value.
    dbMock.single.mockResolvedValue(row('5561234'));

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('answers from the cache without touching the database at all', async () => {
    rememberNumber(CITIZEN, '5561234');

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('does not pre-check the number it is about to insert', async () => {
    // The uniqueness constraint is the authority. A check-then-insert has a race between two
    // players connecting in the same tick that no amount of care in TypeScript closes.
    await ensureNumber(CITIZEN);

    const reads = dbMock.single.mock.calls.map((call) => String(call[0]));
    expect(reads.every((query) => query.includes('`citizenid` = ?'))).toBe(true);
  });

  it('tries another number when the one it generated is taken', async () => {
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    const number = await ensureNumber(CITIZEN);

    expect(number).toMatch(/^\d{7}$/);
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it('yields to the winner when a concurrent connect got there first', async () => {
    // A duplicate can come from either key and they mean opposite things. A duplicate
    // citizenid is not a collision to retry — no new candidate resolves it — so the row is
    // re-read and the winner's number is returned.
    dbMock.single.mockResolvedValueOnce(null).mockResolvedValue(row('5567777'));
    dbMock.insert.mockRejectedValue(duplicate());

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5567777');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(numberFor(CITIZEN)).toBe('5567777');
  });

  it('gives up loudly rather than looping forever when the space is exhausted', async () => {
    // Bounded and loud, because the alternatives are a hang and — far worse — handing out a
    // number somebody already holds.
    dbMock.insert.mockRejectedValue(duplicate());

    await expect(ensureNumber(CITIZEN)).resolves.toBeNull();
    expect(dbMock.insert).toHaveBeenCalledTimes(MAX_ASSIGN_ATTEMPTS);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain('exhausted');
  });

  it('stops at once on a failure that is not a duplicate, and names the table', async () => {
    dbMock.insert.mockRejectedValue(new Error("Table 'gos_phone_numbers' doesn't exist"));

    await expect(ensureNumber(CITIZEN)).resolves.toBeNull();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
  });

  it('refuses an empty citizenid rather than issuing a number to nobody', async () => {
    await expect(ensureNumber('')).resolves.toBeNull();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

/**
 * The soft-delete wedge, and why this is a suite rather than a comment.
 *
 * `citizenid_unique` is on the citizenid alone, and `defineService` supplies a `status` ENUM
 * carrying `'deleted'` on every table by construction. So a row that ever reached
 * `status = 'deleted'` occupies that citizenid's slot permanently — `lib/retention.ts` is
 * explicit that nothing in this codebase ever hard-deletes a soft-deleted row, because the
 * moderation system depends on one surviving forever, so no sweep ever frees it. Every
 * subsequent insert for that player then violates the key whichever number it carries,
 * `ensureNumber` burns all its attempts, and the symptom is a player who silently never gets
 * a phone number again.
 *
 * It is unreachable today: `write: 'server'` and `disableDelete` leave no path that sets
 * `'deleted'` on this table. It is still a landmine for whoever adds a "release a number"
 * action or a character-cleanup sweep, and the fix — assignment restores rather than inserts
 * — is invisible in the code it protects. So it is pinned here the way
 * `reachability.test.ts` pins the reachable set: a structural assumption nothing else would
 * notice being broken.
 */
describe('a soft-deleted row never wedges a citizenid', () => {
  it('hands back the number and brings the row back to active', async () => {
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');

    expect(dbMock.update).toHaveBeenCalledTimes(1);
    const [query, params] = dbMock.update.mock.calls[0];
    expect(String(query)).toContain('`status` = ?');
    expect(params).toContain('active');
    // Ownership-scoped, with the citizenid the server resolved — not an unscoped write.
    expect(params).toContain(CITIZEN);
    // And never a second row: the wedge is that inserting is impossible, not that it is slow.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('caches the reclaimed number, so the synchronous bridge sees it too', async () => {
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));

    await ensureNumber(CITIZEN);

    expect(numberFor(CITIZEN)).toBe('5561234');
  });

  it('leaves a live row completely alone', async () => {
    // The unchanged path, asserted so the reactivation cannot start firing on every connect.
    dbMock.single.mockResolvedValue(row('5561234', 'active'));

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('claims a soft-deleted row reached through the citizenid_unique violation', async () => {
    // The path a race takes: nothing on the pre-check, the insert refused by the citizenid
    // key, and a soft-deleted row behind it. No new candidate can ever get past that key, so
    // retrying is the wrong answer however many attempts are left.
    dbMock.single.mockResolvedValueOnce(null).mockResolvedValue(row('5567777', 'deleted'));
    dbMock.insert.mockRejectedValue(duplicate());

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5567777');

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it('still retries when the violation was a genuine number collision', async () => {
    // The other key, unchanged. Nothing exists for this citizenid, so the claim finds no row
    // and the loop generates another candidate — which is what a `number_unique` clash means.
    dbMock.single.mockResolvedValue(null);
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    await expect(ensureNumber(CITIZEN)).resolves.toMatch(/^\d{7}$/);

    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('returns the number even when the reactivation itself fails, and says so', async () => {
    // The row is theirs either way and every read of this table is status-blind by design.
    // Refusing to tell a player their own number because a status column would not move is
    // worse than a stale status with a line in the log.
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));
    dbMock.update.mockResolvedValue(false);

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');

    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain('reactivate');
  });
});

describe('reading a number back', () => {
  it('scopes the lookup by citizenid', async () => {
    dbMock.single.mockResolvedValue(row('5561234'));

    await expect(readNumber(CITIZEN)).resolves.toBe('5561234');
    expect(dbMock.single.mock.calls[0][1]).toEqual([CITIZEN]);
  });

  it('resolves a number back to its owner', async () => {
    dbMock.single.mockResolvedValue({ citizenid: OTHER });

    await expect(readCitizenIdByNumber('5561234')).resolves.toBe(OTHER);
  });

  it('answers null for an unknown citizenid or number, without a query for an empty one', async () => {
    await expect(readNumber('')).resolves.toBeNull();
    await expect(readCitizenIdByNumber('')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

describe('the declaration', () => {
  it('registers no net event, so a payload can never reach this table', () => {
    // A registered net event is reachable whether or not anything routes to it (§2.9). A
    // number is assigned by the server on connect and is never something a client sets,
    // chooses or deletes.
    const registered = (globalThis.onNet as any).mock?.calls ?? [];
    const mine = registered.filter((call: unknown[]) =>
      String(call[0]).startsWith('gos:server:phonenumbers:')
    );

    expect(mine).toEqual([]);
  });

  it('keeps the number out of every client-writable set', () => {
    expect(phoneNumbers.repo.writableColumns).toEqual([]);
    expect(phoneNumbers.repo.filterableColumns).toEqual([]);
  });

  it('holds a number wider than the seven digits it generates', () => {
    // `netGuard.phoneNumberFrom` accepts up to 32 characters off the wire; the column should
    // not be the thing that refuses a number some later migration brings in.
    expect(phoneNumbers.resolved.columns).toContain('number');
    expect(phoneNumbers.resolved.table).toBe(PHONE_NUMBERS_TABLE);
  });

  it('declares uniqueness on both the number and its owner', () => {
    // The constraint is the authority the assignment loop trusts, so its absence would make
    // every test above pass while two players quietly shared a number.
    const unique = phoneNumbers.resolved.indexes
      .map((index) => (Array.isArray(index) ? { columns: index, unique: false } : index))
      .filter((index: any) => index.unique)
      .map((index: any) => index.columns.join(','));

    expect(unique).toContain('number');
    expect(unique).toContain('citizenid');
  });
});

describe('when a number is assigned', () => {
  /** The subscriber this service registered at import, run for one source. */
  const connect = async (src: number) => {
    expect(subscribers.map((s) => s.name)).toContain('phonenumbers');
    for (const subscriber of subscribers) {
      if (subscriber.name === 'phonenumbers') await subscriber.run(src);
    }
  };

  it('assigns on connect, through the player-loaded registry', async () => {
    // Through `onPlayerLoaded` rather than a listener of its own: a subscriber is handed a
    // source that has already been established, so it has no identity to get wrong
    // (MICA-136). On standalone the entry point behind it is `playerJoining`.
    await connect(5);

    expect(numberFor(CITIZEN)).toMatch(/^\d{7}$/);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('assigns nothing on a framework server, whose numbers gOS does not own', async () => {
    // Two sources of truth for a phone number is the drift `FrameworkBridge` exists to
    // prevent: a qb server's `charinfo.phone` is what every other resource on that server
    // reads, and a gOS number beside it would be one only the phone believed.
    for (const kind of ['qb', 'esx', 'unknown']) {
      framework.kind = kind;
      await connect(5);
    }

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(numberFor(CITIZEN)).toBeNull();
  });

  it('assigns nothing to a player the bridge would not name', async () => {
    // No citizenid means `unidentified` already refused and said why. There is nothing to key
    // a number on, and inventing one is the mistake that refusal exists to prevent.
    await connect(999);

    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
