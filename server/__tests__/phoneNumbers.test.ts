// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-151 issued a number where nothing else would; MICA-284 made the number belong to the
 * phone.
 *
 * A number is now micaOS's on standalone and on both qb cores, attached to the phone a player
 * is using and written back into the framework's own field so nothing else on the server goes
 * stale. The properties asserted below are the ones that make that safe: a number is stable
 * across an upgrade (the framework's own is adopted, never replaced), unique (the schema's
 * keys, not a pre-check), stays with the citizen's one phone whichever item they hold
 * (MICA-438), and is never blanked or reissued for a player left holding nothing.
 *
 * `Database` is mocked because it reads `exports.oxmysql` in module scope and must never
 * reach a real connection (AGENTS.md §1). Nothing here executes SQL, so nothing here proves
 * the unique keys exist or that the migration seeds what it says — `generatedSchema.test.ts`
 * holds the committed DDL to the declaration, and `pnpm test:migrations` runs the migration
 * against a real MariaDB on both framework shapes.
 */
const { dbMock, framework, subscribers, bridgeMock, player } = vi.hoisted(() => {
  // The gate is read at import, so the convar has to exist before the modules load. `qb` at
  // import so `deviceItem.ts` registers its usable-item callback; each case sets its own kind.
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
      single: vi.fn(),
      // MICA-430's versioned writes; `versionedWrites` gives it its stand-in.
      transaction: vi.fn()
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
      registerUsableItem: vi.fn(),
      // How many phone items the player holds: one, unless a case says otherwise (MICA-438).
      countItem: vi.fn((_player: unknown, _item: string): number | null => 1)
    },
    player: loaded
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/shell', () => ({
  onPlayerLoaded: (name: string, run: (src: number) => unknown) => {
    subscribers.push({ name, run });
  },
  forgetOnPlayerLoaded: () => {}
}));
vi.mock('../lib/FrameworkBridge', () => ({
  detectFramework: () => framework.kind,
  FrameworkBridge: bridgeMock
}));

import {
  citizenIdForNumber,
  generatePhoneNumber,
  numberFor,
  readCitizenIdByNumber,
  readNumber,
  rememberNumber,
  MAX_ASSIGN_ATTEMPTS,
  PHONE_NUMBERS_TABLE,
  __resetAssignedNumbers
} from '../lib/phoneNumbers';
import { isDuplicateKey } from '../lib/sqlErrors';
import { __setStatusWritesForTests } from '../lib/statusWrites';
import { phoneNumbers, syncNumber, __resetPhoneNumberState } from '../services/PhoneNumbers';
import { __resetDeviceState, deviceForRequest } from '../services/Devices';
import { __resetPhoneItemWarnings } from '../lib/deviceItem';
import { PhoneNumberRepository } from '../repositories/PhoneNumberRepository';
import { versionedWrites } from './versionedWrites';

/**
 * `deviceItem.ts` registers its usable-item callback at import time, and `clearAllMocks` wipes
 * the call that recorded it — so it is taken here, once, while it is still there.
 */
const usePhoneItem: ((src: number) => void) | undefined =
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
  // MICA-430: a versioned write, through this suite's own stand-in.
  versionedWrites(dbMock);
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  __resetAssignedNumbers();
  __resetPhoneNumberState();
  __resetDeviceState();
  __resetPhoneItemWarnings();
  framework.kind = 'standalone';
  player.rawPlayer.PlayerData.charinfo.phone = '5559876';
  player.setPhone.mockReturnValue(true);
  dbMock.single.mockResolvedValue(null);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  // The citizen's phone row already exists (MICA-438: their one phone), so `resolvePhone`
  // writes nothing, and every `insert` and `update` counted below is about a number.
  dbMock.query.mockResolvedValue([
    { id: 1, citizenid: CITIZEN, device_id: 'c'.repeat(32), kind: 'phone', setup_pending: 0 }
  ]);
  bridgeMock.countItem.mockReturnValue(1);
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

/**
 * The SQL and parameters of every `update` this test made, in order. A resolve writes none of
 * its own, so every one is the number sync's.
 */
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
    expect(isDuplicateKey(error)).toBe(true);
  });

  it.each([
    ['a table that was never imported', new Error("Table 'mica_phone_numbers' doesn't exist")],
    ['a dead connection', Object.assign(new Error('ECONNREFUSED'), { errno: -111 })],
    ['nothing at all', undefined],
    ['null', null]
  ])('does not mistake %s for one', (_label, error) => {
    expect(isDuplicateKey(error)).toBe(false);
  });
});

/**
 * Issuing a number, through the sync, on a server with no framework: the citizen's one phone
 * (MICA-438), whose own number row is read first and its citizen's legacy row second (MICA-439),
 * before anything is generated.
 */
const issue = async (kind = 'standalone'): Promise<string | null> => {
  framework.kind = kind;
  return await syncNumber(5);
};

describe('assigning a number', () => {
  const PHONE_ID = 'c'.repeat(32);

  it('issues one onto the phone and remembers it, so the synchronous bridge can read it', async () => {
    const number = await issue();

    expect(number).toMatch(/^\d{7}$/);
    expect(numberFor(CITIZEN)).toBe(number);
    expect(citizenIdForNumber(number!)).toBe(CITIZEN);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(String(dbMock.insert.mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
    expect(dbMock.insert.mock.calls[0][1]).toContain(PHONE_ID);
  });

  it('never issues a second one to a player whose phone already has theirs', async () => {
    // A reconnecting player keeps their number, or every contact anybody saved for them
    // points at somebody else. That is what makes this a table rather than a runtime value.
    dbMock.single.mockResolvedValue(row('5561234'));

    await expect(issue()).resolves.toBe('5561234');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("reads the phone's row, then the citizen's legacy row, and never pre-checks the number", async () => {
    // A legacy row is a number not yet on any phone — `device_id IS NULL` is its definition.
    // The uniqueness constraint is the authority on the number itself: a check-then-insert
    // has a race between two players connecting in the same tick that nothing closes.
    await issue();

    const reads = dbMock.single.mock.calls.map((call) => ({
      sql: String(call[0]).replace(/\s+/g, ' '),
      params: call[1] as unknown[]
    }));
    expect(reads).toHaveLength(2);
    expect(reads[0].sql).toContain('WHERE `device_id` = ?');
    expect(reads[0].params).toEqual([PHONE_ID]);
    expect(reads[1].sql).toContain('`citizenid` = ? AND `device_id` IS NULL');
    expect(reads[1].params).toEqual([CITIZEN]);
  });

  it('tries another number when the one it generated is taken', async () => {
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    const number = await issue();

    expect(number).toMatch(/^\d{7}$/);
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it('yields to the winner when a concurrent sync got there first', async () => {
    // A duplicate is re-read against this phone's row before another candidate is tried, so a
    // sync that lost the race takes the winner's number rather than a second.
    dbMock.single
      .mockResolvedValueOnce(null) // no number on the phone yet
      .mockResolvedValueOnce(null) // and no legacy row
      .mockResolvedValue(row('5567777')); // the winner's, read back after the duplicate
    dbMock.insert.mockRejectedValue(duplicate());

    await expect(issue()).resolves.toBe('5567777');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(numberFor(CITIZEN)).toBe('5567777');
  });

  it('gives up loudly rather than looping forever when the space is exhausted', async () => {
    // Bounded and loud, because the alternatives are a hang and — far worse — handing out a
    // number somebody already holds.
    dbMock.insert.mockRejectedValue(duplicate());

    await expect(issue()).resolves.toBeNull();
    expect(dbMock.insert).toHaveBeenCalledTimes(MAX_ASSIGN_ATTEMPTS);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain('exhausted');
  });

  it('stops at once on a failure that is not a duplicate, and names the table', async () => {
    dbMock.insert.mockRejectedValue(new Error("Table 'mica_phone_numbers' doesn't exist"));

    await expect(issue()).resolves.toBeNull();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(PHONE_NUMBERS_TABLE);
  });

  it("adopts the framework's own number before generating anything", async () => {
    // The upgrade guarantee: a qb character already has a `charinfo.phone`, and every contact
    // anybody saved for them points at it. It is tried first, so nobody's number changes.
    await expect(issue('qb')).resolves.toBe('5559876');

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.insert.mock.calls[0][1]).toContain('5559876');
  });

  it("issues a fresh one when the framework's number is already on another phone, and says so", async () => {
    // qb does not stop two characters sharing a `charinfo.phone`. The second to connect
    // cannot have it — two phones on one number is the bug this table exists to prevent — so
    // they get a fresh number, and the log says why theirs changed.
    dbMock.insert.mockRejectedValueOnce(duplicate()).mockResolvedValue(1);

    const number = await issue('qb');

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

    await expect(issue()).resolves.toBe('5561234');

    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('`status` = ?');
    expect(updates()[0].params).toContain('active');
    // Ownership-scoped, by the owner's citizenid — not an unscoped write.
    expect(updates()[0].params).toContain(CITIZEN);
    // And never a second row.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('caches the reclaimed number, so the synchronous bridge sees it too', async () => {
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));

    await issue();

    expect(numberFor(CITIZEN)).toBe('5561234');
  });

  it('leaves a live row completely alone', async () => {
    // The unchanged path, asserted so the reactivation cannot start firing on every connect.
    dbMock.single.mockResolvedValue(row('5561234', 'active'));

    await expect(issue()).resolves.toBe('5561234');

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('returns the number even when the reactivation itself fails, and says so', async () => {
    // The row is theirs either way and every read of this table is status-blind by design.
    // Refusing to tell a player their own number because a status column would not move is
    // worse than a stale status with a line in the log.
    dbMock.single.mockResolvedValue(row('5561234', 'deleted'));
    dbMock.update.mockResolvedValue(false);

    await expect(issue()).resolves.toBe('5561234');

    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain('reactivate');
  });
});

/**
 * MICA-439: the number stays with the phone through a phone item turned off after it was on,
 * and on after it was off. Driven against a number table kept in memory, with every sync from a
 * cold cache, as after the restart an operator's convar change takes: before MICA-439 the
 * ungated sync read only a legacy row, missed the one already on the phone, and issued another.
 */
describe('the number through a phone item turned on and off (MICA-439)', () => {
  const PHONE_ID = 'c'.repeat(32);
  type Stored = { id: number; citizenid: string; number: string; device_id: string | null };
  let table: Stored[];

  beforeEach(() => {
    table = [];
    framework.kind = 'qb';
    dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      const found = flat.includes('`device_id` IS NULL')
        ? table.find((r) => r.citizenid === params[0] && r.device_id === null)
        : flat.includes('WHERE `device_id` = ?')
          ? table.find((r) => r.device_id === params[0])
          : undefined;
      return found ? { ...found, status: 'active' } : null;
    });
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!String(sql).includes(PHONE_NUMBERS_TABLE)) return 1;
      const columns = /\(([^)]*)\) VALUES/
        .exec(String(sql))![1]
        .split(',')
        .map((column) => column.trim().replace(/`/g, ''));
      const values = Object.fromEntries(columns.map((column, i) => [column, params[i]]));
      // `number_unique`, as the schema has it.
      if (table.some((r) => r.number === values.number)) throw duplicate();
      table.push({
        id: table.length + 1,
        citizenid: String(values.citizenid),
        number: String(values.number),
        device_id: (values.device_id as string | undefined) ?? null
      });
      return table.length;
    });
  });

  const gated = (on: boolean) => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_phone_item' ? (on ? 'phone' : '') : fallback;
  };

  /** One sync, from a cold cache. */
  const coldSync = async (): Promise<string | null> => {
    __resetPhoneNumberState();
    __resetAssignedNumbers();
    return await syncNumber(5);
  };

  afterEach(() => {
    gated(true);
  });

  it('keeps the number when the gate is turned off after it was on', async () => {
    gated(true);
    await expect(coldSync()).resolves.toBe('5559876');
    gated(false);
    await expect(coldSync()).resolves.toBe('5559876');

    expect(table).toEqual([{ id: 1, citizenid: CITIZEN, number: '5559876', device_id: PHONE_ID }]);
    // Nothing new was written back: the framework's number is the phone's still.
    expect(player.setPhone).not.toHaveBeenCalled();
  });

  it('keeps the number when the gate is turned on after it was off', async () => {
    gated(false);
    await expect(coldSync()).resolves.toBe('5559876');
    gated(true);
    await expect(coldSync()).resolves.toBe('5559876');

    expect(table).toEqual([{ id: 1, citizenid: CITIZEN, number: '5559876', device_id: PHONE_ID }]);
  });

  /**
   * MICA-438 review: the attach is a plain scoped update that writes no version, so it needs
   * nothing MICA-430 added — a database `micaschema apply` has not caught up attaches the same.
   * One that fails anyway leaves the legacy row the citizen's number, unattached: nothing is
   * issued in its place, and the next sync tries again.
   */
  describe('the attach', () => {
    beforeEach(() => {
      table.push({ id: 1, citizenid: CITIZEN, number: '5554444', device_id: null });
      gated(false);
    });

    afterEach(() => {
      __setStatusWritesForTests(true);
    });

    const attaches = () => updates().filter((u) => u.sql.includes('SET `device_id` = ?'));
    const saidCouldNotAttach = () =>
      vi
        .mocked(console.error)
        .mock.calls.filter(([line]) => String(line).includes('could not attach'));

    it('is one scoped update of a legacy row of theirs, with no version, on an ungated first sync', async () => {
      await expect(coldSync()).resolves.toBe('5554444');

      expect(attaches()).toHaveLength(1);
      expect(attaches()[0].sql.replace(/\s+/g, ' ')).toBe(
        `UPDATE \`${PHONE_NUMBERS_TABLE}\` SET \`device_id\` = ? ` +
          'WHERE `id` = ? AND `citizenid` = ? AND `device_id` IS NULL'
      );
      expect(attaches()[0].params).toEqual([PHONE_ID, 1, CITIZEN]);
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('lands before micaschema apply too, since it writes no version', async () => {
      // The gate that holds every versioned write until the ledger is current (MICA-430).
      __setStatusWritesForTests(false);

      await expect(coldSync()).resolves.toBe('5554444');

      expect(attaches().map((u) => u.params)).toEqual([[PHONE_ID, 1, CITIZEN]]);
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('answers the legacy number when the attach throws, says so, and tries again', async () => {
      dbMock.update.mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));

      await expect(coldSync()).resolves.toBe('5554444');
      expect(numberFor(CITIZEN)).toBe('5554444');
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(saidCouldNotAttach()).toHaveLength(1);

      // Not cached as settled: the next sync, same process, tries the attach again.
      await expect(syncNumber(5)).resolves.toBe('5554444');
      expect(attaches().map((u) => u.params)).toEqual([
        [PHONE_ID, 1, CITIZEN],
        [PHONE_ID, 1, CITIZEN]
      ]);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('takes the row a concurrent sync put on the phone first, when it is theirs', async () => {
      // `device_id_unique` refuses the attach: the driver's duplicate code reaches the branch.
      dbMock.update.mockImplementationOnce(async () => {
        table.push({ id: 2, citizenid: CITIZEN, number: '5557777', device_id: PHONE_ID });
        throw Object.assign(new Error("Duplicate entry 'cccc' for key 'device_id_unique'"), {
          errno: 1062,
          code: 'ER_DUP_ENTRY'
        });
      });

      await expect(coldSync()).resolves.toBe('5557777');
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(saidCouldNotAttach()).toEqual([]);

      // Settled: the next sync answers from the cache, with no read.
      dbMock.single.mockClear();
      await expect(syncNumber(5)).resolves.toBe('5557777');
      expect(dbMock.single).not.toHaveBeenCalled();
    });

    it('takes nothing from a concurrent row that names somebody else, and settles nothing', async () => {
      dbMock.update.mockImplementationOnce(async () => {
        table.push({ id: 2, citizenid: OTHER, number: '5557777', device_id: PHONE_ID });
        throw Object.assign(new Error("Duplicate entry 'cccc' for key 'device_id_unique'"), {
          errno: 1062,
          code: 'ER_DUP_ENTRY'
        });
      });

      await expect(coldSync()).resolves.toBeNull();
      expect(numberFor(CITIZEN)).toBeNull();
      expect(dbMock.insert).not.toHaveBeenCalled();
    });
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
    // adopted from qb keeps whatever shape qb gave it. `device_id` is NULL on a legacy row —
    // a number not yet attached to a phone — so it cannot be NOT NULL.
    expect(phoneNumbers.resolved.columns).toContain('number');
    expect(phoneNumbers.resolved.columns).toContain('device_id');
    expect(phoneNumbers.resolved.table).toBe(PHONE_NUMBERS_TABLE);

    const deviceId = phoneNumbers.resolved.fields.find((f) => f.name === 'device_id');
    expect(deviceId?.def.notNull).toBeFalsy();
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
    expect(unique).toContain('device_id');
    expect(unique).not.toContain('citizenid');
  });

  it('puts its privileged write on a named repository, not a service-level bypass', () => {
    expect(phoneNumbers.repo).toBeInstanceOf(PhoneNumberRepository);
    // MICA-438: the put-back to a phone's owner went with the handover; one write is left.
    expect('transferToHolder' in phoneNumbers.repo).toBe(false);
  });
});

/**
 * The sync: the phone a player is on decides the number they are on — their one phone, held
 * by any phone item (MICA-438).
 *
 * Driven through the entry point the phone item fires on a load, because that is the one
 * place every trigger converges — the load, the usable-item callback and the inventory relay —
 * and a subscriber of `onPlayerLoaded` alone would be stale the moment a player who held no
 * phone picked one up.
 */
describe('syncing the number with the phone in hand', () => {
  const PHONE_ID = 'c'.repeat(32);

  it('gives a tablet no number: resolving one and a load write no number row (MICA-264)', async () => {
    const TABLET = 'd'.repeat(32);
    framework.kind = 'qb';
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_phone_item' ? 'phone' : name === 'mica_tablet_item' ? 'tablet' : fallback;
    try {
      // A tablet in hand and no phone at all.
      bridgeMock.countItem.mockImplementation((_p: unknown, item: string) =>
        item === 'tablet' ? 1 : 0
      );
      dbMock.query.mockImplementation(async (_sql: string, params: unknown[] = []) =>
        params.includes('tablet')
          ? [{ id: 2, citizenid: CITIZEN, device_id: TABLET, kind: 'tablet', setup_pending: 0 }]
          : []
      );

      await expect(deviceForRequest(5, CITIZEN, 'tablet')).resolves.toBe(TABLET);
      await load(5);

      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(updates()).toEqual([]);
      expect(numberFor(CITIZEN)).toBeNull();
      // Nothing asked the number table about the tablet's id either.
      for (const [, params] of dbMock.single.mock.calls) {
        expect(params as unknown[]).not.toContain(TABLET);
      }
    } finally {
      (globalThis as any).GetConvar = previous;
    }
  });

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
    try {
      await load(5);

      expect(numberFor(CITIZEN)).toBe('5559876');
      expect(dbMock.insert.mock.calls[0][1]).toContain('5559876');
      // On the citizen's phone, counted or not (MICA-439), so turning a gate on later keeps it.
      expect(dbMock.insert.mock.calls[0][1]).toContain(PHONE_ID);
      expect(bridgeMock.countItem).not.toHaveBeenCalled();
      expect(player.setPhone).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).GetConvar = (name: string, fallback: string) =>
        name === 'mica_phone_item' ? 'phone' : fallback;
    }
  });

  it("numbers the citizen's own phone where the inventory cannot count, failing open", async () => {
    framework.kind = 'qb';
    bridgeMock.countItem.mockReturnValue(null);

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert.mock.calls[0][1]).toContain(PHONE_ID);
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

  it("attaches the citizen's legacy number to their phone the first time they hold it", async () => {
    // The upgrade path: the migration left their number as a legacy row with no phone, and
    // their phone takes it. Nobody's number changes; it moves onto the phone.
    framework.kind = 'qb';
    dbMock.single
      .mockResolvedValueOnce(null) // no number on this phone yet
      .mockResolvedValueOnce(row('5559876')); // their legacy row

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('`device_id` = ?');
    expect(updates()[0].params).toEqual([PHONE_ID, 42, CITIZEN]);
  });

  it('gives a phone with no number and a citizen with no legacy row a number of its own', async () => {
    framework.kind = 'qb';

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toContain('`device_id`');
    expect(params).toContain(PHONE_ID);
  });

  /**
   * MICA-438 review: a number row on this phone naming somebody else — only a handover before
   * MICA-436 could leave one — is not this owner's to take. On old data it is the other
   * citizen's lifelong number: adopting it would leave them a fresh one. It is detached, by a
   * named write scoped by the row, the phone and the citizen it must not name, so it is that
   * citizen's legacy number again, and this phone goes on to its owner's own.
   */
  it("detaches a row on this phone that names somebody else, and goes on to the owner's own", async () => {
    framework.kind = 'qb';
    dbMock.single
      .mockResolvedValueOnce(row('5561111', 'active', OTHER)) // the row on this phone
      .mockResolvedValueOnce(null); // and no legacy row of the owner's

    await expect(syncNumber(5)).resolves.toBe('5559876');

    const [detach] = updates();
    expect(detach.sql.replace(/\s+/g, ' ')).toBe(
      `UPDATE \`${PHONE_NUMBERS_TABLE}\` SET \`device_id\` = NULL ` +
        'WHERE `id` = ? AND `device_id` = ? AND `citizenid` <> ?'
    );
    expect(detach.params).toEqual([42, PHONE_ID, CITIZEN]);
    // The owner's own number, on their phone: the framework's, as for any first number.
    expect(dbMock.insert.mock.calls[0][1]).toEqual(expect.arrayContaining(['5559876', PHONE_ID]));
    expect(citizenIdForNumber('5561111')).not.toBe(CITIZEN);
    // Said once, by token: nothing names either citizen or the phone in the clear.
    const said = vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes('before MICA-436'));
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain(CITIZEN);
    expect(said[0]).not.toContain(OTHER);
    expect(said[0]).not.toContain(PHONE_ID);
  });

  it('takes nothing when the stray row moved before it could be detached', async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValueOnce(row('5561111', 'active', OTHER));
    dbMock.update.mockResolvedValueOnce(false);

    await expect(syncNumber(5)).resolves.toBeNull();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(numberFor(CITIZEN)).toBeNull();
  });

  it("detaches nothing for the owner's own row (the positive twin)", async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValueOnce(row('5561111', 'active', CITIZEN));

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5561111');
    expect(updates()).toEqual([]);
  });

  /**
   * MICA-438: a phone item is a key. Whoever bought the copy in this citizen's hand — another
   * citizen whose item it was — it syncs the holder's own phone and number, and reads nothing of
   * the other citizen's.
   */
  it("syncs the holder's own phone and number whoever's item it is, and reads no other", async () => {
    const VICTIMS = 'f'.repeat(32);
    framework.kind = 'qb';
    dbMock.single.mockImplementation(async (_sql: string, params: unknown[] = []) =>
      params[0] === PHONE_ID
        ? row('5559876', 'active', CITIZEN)
        : params[0] === VICTIMS
          ? row('5561111', 'active', OTHER)
          : null
    );
    rememberNumber(OTHER, '5561111');

    await load(5);

    expect(numberFor(CITIZEN)).toBe('5559876');
    // The identity read names the holder and nobody else.
    for (const [, params] of dbMock.query.mock.calls) expect(params).toEqual([CITIZEN, 'phone']);
    for (const [, params] of dbMock.single.mock.calls) {
      expect(params as unknown[]).not.toContain(VICTIMS);
    }
    expect(updates()).toEqual([]);
    expect(dbMock.insert).not.toHaveBeenCalled();
    // The other citizen's number still answers them.
    expect(citizenIdForNumber('5561111')).toBe(OTHER);
  });

  it('leaves everything alone for a player holding no phone on a gated server', async () => {
    // The framework's last value is deliberately kept: a blank `charinfo.phone` breaks every
    // other resource that reads one, where a stale one merely fails to reach somebody who has
    // no phone to be reached on anyway.
    framework.kind = 'qb';
    bridgeMock.countItem.mockReturnValue(0);
    rememberNumber(CITIZEN, '5559876');

    await load(5);

    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(player.setPhone).not.toHaveBeenCalled();
    expect(numberFor(CITIZEN)).toBe('5559876');
  });

  it('writes back only when the framework disagrees', async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValueOnce(row('5559876', 'active', CITIZEN));

    await load(5);

    expect(player.setPhone).not.toHaveBeenCalled();
  });

  it('says once when the framework refuses the write-back, and keeps the number', async () => {
    framework.kind = 'qb';
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

    await Promise.all([syncNumber(5), syncNumber(5), syncNumber(5)]);

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  /**
   * MICA-336: a multichar switch keeps the source, so a sync still in flight for the previous
   * character was joined by the next one's load, which then got that character's number and
   * no sync of its own. The same character's triggers still share one run, queued behind the
   * one going (MICA-346).
   */
  it('never hands a sync in flight for one character to the next on the same source', async () => {
    framework.kind = 'qb';
    try {
      const forA = syncNumber(5);
      // The positive twin: A's later triggers share one run queued behind A's.
      const againA = syncNumber(5);
      expect(againA).not.toBe(forA);
      expect(syncNumber(5)).toBe(againA);

      // Character B loads on the same source before A's sync has settled.
      bridgeMock.getPlayer.mockImplementation((src: number) =>
        src === 5 ? { ...player, citizenid: OTHER } : null
      );
      const forB = syncNumber(5);

      expect(forB).not.toBe(forA);
      expect(forB).not.toBe(againA);
      // And B's later triggers queue behind B's run, not A's.
      const againB = syncNumber(5);
      expect(againB).not.toBe(againA);
      expect(syncNumber(5)).toBe(againB);
      // A's queued run finds B on the source and leaves the sync to B's own.
      await expect(againA).resolves.toBeNull();
      await Promise.allSettled([forA, forB, againB]);
    } finally {
      bridgeMock.getPlayer.mockImplementation((src: number) => (src === 5 ? player : null));
    }
  });

  /**
   * MICA-346, under MICA-438: a run counts the phone in hand when it starts, so a trigger that
   * joined a run already going missed what changed after it. A phone picked up while a run that
   * found none was still going would have had no number until the next trigger.
   */
  it('numbers a phone picked up while a sync that found none is still running', async () => {
    framework.kind = 'qb';
    bridgeMock.countItem.mockReturnValue(0);
    dbMock.single.mockImplementation(async (_sql: string, params: unknown[] = []) =>
      params[0] === PHONE_ID ? row('5559876') : null
    );

    // The load's sync counts no phone the moment it starts.
    const forNone = syncNumber(5);
    // The player picks a phone up and uses it before that run has finished.
    bridgeMock.countItem.mockReturnValue(1);
    expect(usePhoneItem, 'the phone item registers a usable-item callback').toBeTypeOf('function');
    usePhoneItem!(5);
    const forPhone = syncNumber(5);

    await expect(forNone).resolves.toBeNull();
    await expect(forPhone).resolves.toBe('5559876');
    expect(numberFor(CITIZEN)).toBe('5559876');
  });

  /**
   * MICA-336: a switch landing in one of the sync's awaits keeps the source, and the run goes
   * on as the previous character. Its write-back is addressed by source on qbx
   * (`SetCharInfo(src, …)`), so finishing it gave the next character the previous one's number.
   * The run is abandoned once the source holds somebody else.
   */
  it('abandons a sync whose character switched out under it, and writes nothing', async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValue(row('5559876', 'active', CITIZEN));
    const next = { ...player, citizenid: OTHER, setPhone: vi.fn(() => true) };
    // The switch lands while A's sync is reading A's phone row.
    dbMock.query.mockImplementationOnce(async () => {
      bridgeMock.getPlayer.mockImplementation((src: number) => (src === 5 ? next : null));
      return [{ id: 1, citizenid: CITIZEN, device_id: PHONE_ID, kind: 'phone', setup_pending: 0 }];
    });
    try {
      await expect(syncNumber(5)).resolves.toBeNull();

      // Nothing written back through either character, and no number row moved to anybody.
      expect(player.setPhone).not.toHaveBeenCalled();
      expect(next.setPhone).not.toHaveBeenCalled();
      expect(updates()).toEqual([]);
      expect(numberFor(OTHER)).toBeNull();
    } finally {
      bridgeMock.getPlayer.mockImplementation((src: number) => (src === 5 ? player : null));
    }
  });

  it('still finishes a sync when nothing switched (the positive twin)', async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValue(row('5559876', 'active', CITIZEN));

    await expect(syncNumber(5)).resolves.toBe('5559876');
  });

  it('costs no query when nothing has changed since the last sync', async () => {
    framework.kind = 'qb';
    dbMock.single.mockResolvedValueOnce(row('5559876', 'active', CITIZEN));

    await load(5);
    dbMock.single.mockClear();
    dbMock.query.mockClear();
    await load(5);

    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('gives a player their number back when they pick a phone up again', async () => {
    // Robbed, then a new phone bought: the same phone, so the same number (MICA-438).
    framework.kind = 'qb';
    bridgeMock.countItem.mockReturnValue(0);
    dbMock.single.mockResolvedValue(row('5552222', 'active', CITIZEN));
    player.rawPlayer.PlayerData.charinfo.phone = '5552222';

    await load(5);
    expect(numberFor(CITIZEN)).toBeNull();

    bridgeMock.countItem.mockReturnValue(1);
    usePhoneItem!(5);
    await syncNumber(5);

    expect(numberFor(CITIZEN)).toBe('5552222');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });
});
