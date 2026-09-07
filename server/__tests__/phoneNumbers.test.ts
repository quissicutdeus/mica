// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-151 issued a number where nothing else would; MICA-284 made the number belong to the
 * phone.
 *
 * A number is now micaOS's on standalone and on both qb cores, attached to the phone a player
 * is using and written back into the framework's own field so nothing else on the server goes
 * stale. The properties asserted below are the ones that make that safe: a number is stable
 * across an upgrade (the framework's own is adopted, never replaced), unique (the schema's
 * keys, not a pre-check), follows the phone when it changes hands, and is never blanked or
 * reissued for a player left holding nothing.
 *
 * `Database` is mocked because it reads `exports.oxmysql` in module scope and must never
 * reach a real connection (AGENTS.md §1). Nothing here executes SQL, so nothing here proves
 * the unique keys exist or that the migration seeds what it says — `generatedSchema.test.ts`
 * holds the committed DDL to the declaration, and `pnpm test:migrations` runs the migration
 * against a real MariaDB on both framework shapes.
 */
const { dbMock, framework, subscribers, bridgeMock, player } = vi.hoisted(() => {
  // The gate is read at import, so the convar has to exist before the modules load. `qb` at
  // import so `phoneItem.ts` registers its usable-item callback; each case sets its own kind.
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_phone_item' ? 'phone' : fallback;
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).on = vi.fn();
  (globalThis as any).onNet = vi.fn();

  const CITIZEN = `license:${'a'.repeat(40)}`;
  /** A loaded qb player whose framework already issued `5559876`. */
  const loaded = {
    citizenid: CITIZEN,
    source: 5,
    phone: undefined as string | undefined,
    setPhone: vi.fn(() => true),
    rawPlayer: { PlayerData: { citizenid: CITIZEN, charinfo: { phone: '5559876' } } }
  };

  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    framework: { kind: 'qb' as string },
    /**
     * What `onPlayerLoaded` was handed at import.
     *
     * `lib/shell.ts` is mocked rather than imported so this suite drives the subscriber
     * directly, without registering the real `playerJoining` listener or dragging the orphan
     * sweep in behind it. `playerLoaded.test.ts` is what proves the registry and its entry
     * points behave; this only needs the one subscriber the phone item adds.
     */
    subscribers: [] as { name: string; run: (src: number) => unknown }[],
    bridgeMock: {
      getPlayer: vi.fn((src: number) => (src === 5 ? loaded : null)),
      getCitizenId: vi.fn((src: number) => (src === 5 ? CITIZEN : null)),
      getAllPlayers: vi.fn(() => ({})),
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1)
    },
    player: loaded
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/shell', () => ({
  onPlayerLoaded: (name: string, run: (src: number) => unknown) => {
    subscribers.push({ name, run });
  }
}));
vi.mock('../lib/FrameworkBridge', () => ({
  detectFramework: () => framework.kind,
  FrameworkBridge: bridgeMock
}));

import {
  citizenIdForNumber,
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
import {
  ensureNumber,
  phoneNumbers,
  syncNumber,
  __resetPhoneNumberState
} from '../services/PhoneNumbers';
import { __resetPhoneState } from '../services/Phones';
import { __resetLastUsedPhone, __resetPhoneItemWarnings } from '../lib/phoneItem';
import { PhoneNumberRepository } from '../repositories/PhoneNumberRepository';

/**
 * `phoneItem.ts` registers its usable-item callback at import time, and `clearAllMocks` wipes
 * the call that recorded it — so it is taken here, once, while it is still there.
 */
const usePhoneItem: ((src: number, used?: { slot?: unknown }) => void) | undefined =
  bridgeMock.registerUsableItem.mock.calls.find((call: unknown[]) => call[0] === 'phone')?.[1];

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  __resetAssignedNumbers();
  __resetPhoneNumberState();
  __resetPhoneState();
  __resetLastUsedPhone();
  __resetPhoneItemWarnings();
  framework.kind = 'standalone';
  player.rawPlayer.PlayerData.charinfo.phone = '5559876';
  player.setPhone.mockReturnValue(true);
  dbMock.single.mockResolvedValue(null);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  // The `mica_phones` row already exists, so `resolvePhone` inserts nothing of its own and
  // every `insert` counted below is a number.
  dbMock.query.mockResolvedValue([{ id: 1 }]);
  bridgeMock.itemSlots.mockReturnValue(null);
  bridgeMock.setItemMetadata.mockReturnValue(true);
});

/** A row as `readLegacyRow` and `readRowByPhoneId` select it. */
const row = (number: string, status = 'active', citizenid = CITIZEN) => ({
  id: 42,
  citizenid,
  number,
  status
});

/** `syncNumber` through the entry point the phone item fires on a character load. */
const load = async (src: number): Promise<void> => {
  const subscriber = subscribers.find((s) => s.name === 'phone-item');
  expect(subscriber, 'the phone item subscribes to player load').toBeDefined();
  await subscriber!.run(src);
  // The subscriber is synchronous and the sync it fires is not; let the sync settle.
  await syncNumber(src);
};

/** The SQL and parameters of every `update` this test made, in order. */
const updates = () =>
  dbMock.update.mock.calls.map(([sql, params]) => ({
    sql: String(sql),
    params: params as unknown[]
  }));

describe('the generated number', () => {
  const draws = (samples: number): string[] =>
    Array.from({ length: samples }, () => generatePhoneNumber());

  it('is seven digits, like every number already in the repo', () => {
    // `lib/seed.ts` writes 5550101–5550104, and `netGuard.phoneNumberFrom` only trims and
    // caps at 32 characters — it will not normalise a format mismatch away.
    for (const number of draws(500)) expect(number).toMatch(/^\d{7}$/);
  });

  it('never lands in the exchange `micaseed` owns', () => {
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
    // shown, and hands the same player the same number on every server running micaOS.
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
    ['a table that was never imported', new Error("Table 'mica_phone_numbers' doesn't exist")],
    ['a dead connection', Object.assign(new Error('ECONNREFUSED'), { errno: -111 })],
    ['nothing at all', undefined],
    ['null', null]
  ])('does not mistake %s for one', (_label, error) => {
    expect(isDuplicateEntry(error)).toBe(false);
  });
});

describe('assigning a number', () => {
  it('issues one and remembers it, so the synchronous bridge can read it', async () => {
    const number = await ensureNumber(CITIZEN);

    expect(number).toMatch(/^\d{7}$/);
    expect(numberFor(CITIZEN)).toBe(number);
    expect(citizenIdForNumber(number!)).toBe(CITIZEN);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(String(dbMock.insert.mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
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

  it("looks only at the citizen's legacy rows, and never pre-checks the number", async () => {
    // A legacy row is a number not yet on any phone — `phone_id IS NULL` is its definition,
    // and a number already attached to a phone is that phone's, not the citizen's to reclaim.
    // The uniqueness constraint is the authority on the number itself: a check-then-insert
    // has a race between two players connecting in the same tick that nothing closes.
    await ensureNumber(CITIZEN);

    const reads = dbMock.single.mock.calls.map((call) => String(call[0]));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('`citizenid` = ?');
    expect(reads[0]).toContain('`phone_id` IS NULL');
  });

  it('tries another number when the one it generated is taken', async () => {
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    const number = await ensureNumber(CITIZEN);

    expect(number).toMatch(/^\d{7}$/);
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it('yields to the winner when a concurrent connect got there first', async () => {
    // A duplicate is re-read against this citizen's legacy row before another candidate is
    // tried, so a connect that lost the race takes the winner's number rather than a second.
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
    dbMock.insert.mockRejectedValue(new Error("Table 'mica_phone_numbers' doesn't exist"));

    await expect(ensureNumber(CITIZEN)).resolves.toBeNull();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
  });

  it('refuses an empty citizenid rather than issuing a number to nobody', async () => {
    await expect(ensureNumber('')).resolves.toBeNull();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("adopts the framework's own number before generating anything", async () => {
    // The upgrade guarantee: a qb character already has a `charinfo.phone`, and every contact
    // anybody saved for them points at it. It is tried first, so nobody's number changes.
    await expect(ensureNumber(CITIZEN, '5559876')).resolves.toBe('5559876');

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.insert.mock.calls[0][1]).toContain('5559876');
  });

  it("issues a fresh one when the framework's number is already on another phone, and says so", async () => {
    // qb does not stop two characters sharing a `charinfo.phone`. The second to connect
    // cannot have it — two phones on one number is the bug this table exists to prevent — so
    // they get a fresh number, and the log says why theirs changed.
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    const number = await ensureNumber(CITIZEN, '5559876');

    expect(number).toMatch(/^\d{7}$/);
    expect(number).not.toBe('5559876');
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('already on another phone');
  });
});

/**
 * A soft-deleted row is still the player's number.
 *
 * `defineService` supplies a `status` ENUM carrying `'deleted'` on every table by
 * construction, and `lib/retention.ts` is explicit that nothing in this codebase ever
 * hard-deletes a soft-deleted row. A number is a player's identity rather than a piece of
 * their content, so the right answer to a `'deleted'` row is to bring it back, not to issue a
 * second number beside it. Unreachable today — `write: 'server'` and `disableDelete` leave no
 * path that sets `'deleted'` here — and pinned so that whoever adds a "release a number"
 * action finds this before they find the bug.
 */
describe('a soft-deleted row is still the number', () => {
  it('hands back the number and brings the row back to active', async () => {
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));

    await expect(ensureNumber(CITIZEN)).resolves.toBe('5561234');

    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('`status` = ?');
    expect(updates()[0].params).toContain('active');
    // Ownership-scoped, by the citizenid the row carries — not an unscoped write.
    expect(updates()[0].params).toContain(CITIZEN);
    // And never a second row.
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
  it('scopes the lookup by citizenid, most recently used first', async () => {
    dbMock.single.mockResolvedValue({ number: '5561234' });

    await expect(readNumber(CITIZEN)).resolves.toBe('5561234');
    expect(dbMock.single.mock.calls[0][1]).toEqual([CITIZEN]);
    expect(String(dbMock.single.mock.calls[0][0])).toContain('`updated_at` DESC');
  });

  it('resolves a number back to its holder', async () => {
    dbMock.single.mockResolvedValue({ citizenid: OTHER });

    await expect(readCitizenIdByNumber('5561234')).resolves.toBe(OTHER);
  });

  it('answers null for an unknown citizenid or number, without a query for an empty one', async () => {
    await expect(readNumber('')).resolves.toBeNull();
    await expect(readCitizenIdByNumber('')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });
});

describe('the cache', () => {
  it('moves a number to its new holder, and stops answering it for the old one', () => {
    // The old holder's phone is gone; `numberFor` still answering their old number would let a
    // synchronous reader believe they are reachable there. The new holder is the one the
    // reverse lookup finds — that is what makes a stolen phone ring for the thief.
    rememberNumber(CITIZEN, '5561234');
    rememberNumber(OTHER, '5561234');

    expect(citizenIdForNumber('5561234')).toBe(OTHER);
    expect(numberFor(OTHER)).toBe('5561234');
    expect(numberFor(CITIZEN)).toBeNull();
  });

  it('leaves a holder who has since moved to another number alone', () => {
    rememberNumber(CITIZEN, '5561234');
    rememberNumber(CITIZEN, '5565555');
    rememberNumber(OTHER, '5561234');

    expect(numberFor(CITIZEN)).toBe('5565555');
  });
});

describe('the declaration', () => {
  it('registers no net event, so a payload can never reach this table', () => {
    // A registered net event is reachable whether or not anything routes to it (§2.9). A
    // number is assigned by the server and is never something a client sets, chooses or
    // deletes.
    const registered = (globalThis.onNet as any).mock?.calls ?? [];
    const mine = registered.filter((call: unknown[]) =>
      String(call[0]).startsWith('mica:server:phonenumbers:')
    );

    expect(mine).toEqual([]);
  });

  it('keeps the number and the phone out of every client-writable set', () => {
    expect(phoneNumbers.repo.writableColumns).toEqual([]);
    expect(phoneNumbers.repo.filterableColumns).toEqual([]);
  });

  it('holds a number wider than the seven digits it generates, and a nullable phone id', () => {
    // `netGuard.phoneNumberFrom` accepts up to 32 characters off the wire, and a number
    // adopted from qb keeps whatever shape qb gave it. `phone_id` is NULL on a legacy row —
    // a number not yet attached to a phone — so it cannot be NOT NULL.
    expect(phoneNumbers.resolved.columns).toContain('number');
    expect(phoneNumbers.resolved.columns).toContain('phone_id');
    expect(phoneNumbers.resolved.table).toBe(PHONE_NUMBERS_TABLE);

    const phoneId = phoneNumbers.resolved.fields.find((f) => f.name === 'phone_id');
    expect(phoneId?.def.notNull).toBeFalsy();
  });

  it('declares uniqueness on the number and on the phone, and no longer on the citizen', () => {
    // The constraints are the authority the assignment loop trusts, so their absence would
    // make every test above pass while two phones quietly shared a number. And a character
    // holding two phones holds two numbers, which is why `citizenid_unique` is gone.
    const unique = phoneNumbers.resolved.indexes
      .map((index) => (Array.isArray(index) ? { columns: index, unique: false } : index))
      .filter((index: any) => index.unique)
      .map((index: any) => index.columns.join(','));

    expect(unique).toContain('number');
    expect(unique).toContain('phone_id');
    expect(unique).not.toContain('citizenid');
  });

  it('puts its two privileged writes on a named repository, not a service-level bypass', () => {
    expect(phoneNumbers.repo).toBeInstanceOf(PhoneNumberRepository);
  });
});

/**
 * The sync: the phone a player is on decides the number they are on.
 *
 * Driven through the entry point the phone item fires on a load, because that is the one
 * place every trigger converges — the load, the usable-item callback and the inventory relay —
 * and a subscriber of `onPlayerLoaded` alone would be stale the moment a player picked up a
 * second phone.
 */
describe('syncing the number with the phone in hand', () => {
  const PHONE_ID = 'c'.repeat(32);
  const holding = (phoneId = PHONE_ID) =>
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId } }]);

  it('issues a number on load, on a server with no framework', async () => {
    framework.kind = 'standalone';

    await load(5);

    expect(numberFor(CITIZEN)).toMatch(/^\d{7}$/);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('adopts the framework number on a qb server with no phone item', async () => {
    // The whole path for a qb server that never sets `mica_phone_item`, and the case that
    // makes the upgrade a no-op for it: the number qb issued is the number micaOS records,
    // and there is nothing to write back because they already agree.
    framework.kind = 'qb';
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert.mock.calls[0][1]).toContain('5559876');
    expect(player.setPhone).not.toHaveBeenCalled();

    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_phone_item' ? 'phone' : fallback;
  });

  it('degrades to one number per citizen when the inventory cannot carry a phone id', async () => {
    framework.kind = 'qb';
    bridgeMock.itemSlots.mockReturnValue(null);

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
  });

  it('issues nothing on ESX, and says so once', async () => {
    // No standard setter to write a number back through, so a number only micaOS believed
    // would be exactly the drift MICA-151 refused. The framework keeps it.
    framework.kind = 'esx';

    await load(5);
    await load(5);

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(numberFor(CITIZEN)).toBeNull();
    const said = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(said.filter((line) => line.includes('es_extended'))).toHaveLength(1);
  });

  it('issues nothing while no framework has answered yet', async () => {
    framework.kind = 'unknown';

    await load(5);

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('issues nothing to a player the bridge would not name', async () => {
    // No citizenid means `unidentified` already refused and said why. There is nothing to key
    // a number on, and inventing one is the mistake that refusal exists to prevent.
    framework.kind = 'qb';

    await syncNumber(999);

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("attaches the citizen's legacy number to the first phone they use", async () => {
    // The upgrade path: the migration left their number as a legacy row with no phone, and
    // the phone in their hand takes it. Nobody's number changes; it moves onto the phone.
    framework.kind = 'qb';
    holding();
    dbMock.single
      .mockResolvedValueOnce(null) // no number on this phone yet
      .mockResolvedValueOnce(row('5559876')); // their legacy row

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('`phone_id` = ?');
    expect(updates()[0].params).toEqual([PHONE_ID, 42]);
  });

  it('gives a phone with no number and a citizen with no legacy row a number of its own', async () => {
    framework.kind = 'qb';
    holding();

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toContain('`phone_id`');
    expect(params).toContain(PHONE_ID);
  });

  it('moves a number to whoever is holding the phone it is on, and writes it back', async () => {
    // Steal a phone, steal the number. The row named the previous holder; it now names this
    // one, the reverse lookup answers this one, and the framework is told so every other
    // resource on the server dials the right person.
    framework.kind = 'qb';
    holding();
    dbMock.single.mockResolvedValueOnce(row('5561111', 'active', OTHER));

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5561111');
    expect(citizenIdForNumber('5561111')).toBe(CITIZEN);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('`citizenid` = ?');
    expect(updates()[0].sql).not.toContain('AND `citizenid`');
    expect(updates()[0].params).toEqual([CITIZEN, 42]);
    expect(player.setPhone).toHaveBeenCalledWith('5561111');
  });

  it('leaves everything alone for a player holding no phone on a gated server', async () => {
    // The framework's last value is deliberately kept: a blank `charinfo.phone` breaks every
    // other resource that reads one, where a stale one merely fails to reach somebody who has
    // no phone to be reached on anyway.
    framework.kind = 'qb';
    bridgeMock.itemSlots.mockReturnValue([]);
    rememberNumber(CITIZEN, '5559876');

    await load(5);

    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(player.setPhone).not.toHaveBeenCalled();
    expect(numberFor(CITIZEN)).toBe('5559876');
  });

  it('writes back only when the framework disagrees', async () => {
    framework.kind = 'qb';
    holding();
    dbMock.single.mockResolvedValueOnce(row('5559876', 'active', CITIZEN));

    await load(5);

    expect(player.setPhone).not.toHaveBeenCalled();
  });

  it('says once when the framework refuses the write-back, and keeps the number', async () => {
    framework.kind = 'qb';
    holding();
    player.setPhone.mockReturnValue(false);
    dbMock.single.mockResolvedValue(row('5561111', 'active', CITIZEN));

    await load(5);
    await load(5);

    expect(numberFor(CITIZEN)).toBe('5561111');
    const said = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(said.filter((line) => line.includes('refused'))).toHaveLength(1);
  });

  it('runs one sync per source at a time, so a burst of triggers issues one number', async () => {
    framework.kind = 'qb';
    holding();

    await Promise.all([syncNumber(5), syncNumber(5), syncNumber(5)]);

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('costs no query when nothing has changed since the last sync', async () => {
    framework.kind = 'qb';
    holding();
    dbMock.single.mockResolvedValueOnce(row('5559876', 'active', CITIZEN));

    await load(5);
    dbMock.single.mockClear();
    await load(5);

    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('re-syncs when the player uses a phone, which is how they switch', async () => {
    framework.kind = 'qb';
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { phoneId: 'b'.repeat(32) } },
      { slot: 8, metadata: { phoneId: PHONE_ID } }
    ]);
    dbMock.single
      .mockResolvedValueOnce(row('5552222', 'active', CITIZEN)) // slot 2, on load
      .mockResolvedValueOnce(row('5558888', 'active', CITIZEN)); // slot 8, on use

    await load(5);
    expect(numberFor(CITIZEN)).toBe('5552222');

    expect(usePhoneItem, 'the phone item registers a usable-item callback').toBeTypeOf('function');
    usePhoneItem!(5, { slot: 8 });
    await syncNumber(5);

    expect(numberFor(CITIZEN)).toBe('5558888');
    expect(player.setPhone).toHaveBeenLastCalledWith('5558888');
  });
});
