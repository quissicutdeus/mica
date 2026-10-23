// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, bridgeMock, convar } = vi.hoisted(() => {
  const convar: Record<string, string> = {};
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in convar ? convar[name] : fallback;
  return {
    convar,
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    bridgeMock: {
      getPlayer: vi.fn(),
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1),
      forgetSource: vi.fn(),
      rememberSource: vi.fn(),
      getSourceByCitizenId: vi.fn(() => undefined),
      getSourcesByCitizenId: vi.fn(() => new Map())
    }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qbx'
}));

import { __resetDeviceState, identityPhone, resolvePhone } from '../services/Devices';
// Registers the seeding hook, which is the thing under test.
import '../services/Contacts';
import { __resetOwnerConfig } from '../lib/ownerConfig';
import { who } from '../lib/who';
import { versionedWrites } from './versionedWrites';

/**
 * A default-contacts seed that fails part-way finishes on a later resolve (MICA-327).
 *
 * `mica_contacts` is rows in memory: every insert lands there and the seed's read of what the
 * phone already has reads them back, so "finished", "not doubled" and "not resurrected" are
 * rows, not call counts. A delete is what `Repository.delete` does — the row stays, with
 * `status` set to `'deleted'`.
 */

const SRC = 7;
const CID = 'ABC12345';
const SRC_B = 8;
const CID_B = 'BBB22222';
const CARRIED = 'a'.repeat(32);
const SEED = [
  { name: 'Dispatch', number: '911' },
  { name: 'Mechanic', number: '555-0100' },
  { name: 'Taxi', number: '555-0101' },
  { name: 'Lawyer', number: '555-0102' },
  { name: 'Hospital', number: '555-0103' }
];

type ContactRow = {
  id: number;
  device_id: string;
  phone: string;
  citizenid: string;
  status: string;
  /** Which default the row was seeded as (MICA-335); null on one the player saved. */
  default_number?: string | null;
};
let contactRows: ContactRow[];
/** `setup_pending` absent is a row read before `micaschema apply` added the column. */
type DeviceRow = {
  id: number;
  device_id: string;
  citizenid: string;
  claimed: number;
  setup_pending?: number;
};
let phoneRows: DeviceRow[];
/** Each contacts insert, by its position across the whole case, that throws (once). */
let failInsert: Set<number>;
let insertCount: number;
/** Gates the next contacts insert waits on, in order. */
let gates: Promise<void>[];
/** How many of the next set-up marks throw. */
let failMark: number;
/**
 * Whether inserts honour `device_phone_unique` (MICA-335). Off unless a case is about the key:
 * with it on, a second overlapping seed run would be refused rather than doubling a row, and
 * the MICA-327 cases below exist to show the phone's queue keeps runs from overlapping at all.
 */
let uniqueKey: boolean;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The error oxmysql rejects with across a resource boundary: no `errno`, no `code`, the query
 * and its parameters in the text, and mysql2's own message on the last line only.
 */
const oxmysqlError = (sql: string, params: unknown[], message: string): Error =>
  new Error(
    `mica was unable to execute a query!\nQuery: ${sql}\n${JSON.stringify(params)}\n${message}`
  );

/** Restart micaOS: every in-process map gone, the rows still there. */
const restart = () => __resetDeviceState();

/** `setup_pending` on a phone's row, as a restart would read it. */
const pendingOf = (deviceId: string) =>
  phoneRows.find((row) => row.device_id === deviceId)?.setup_pending;

/** How many times the seed read what a phone already has. */
const seedReads = () =>
  dbMock.query.mock.calls.filter(([sql]) => String(sql).includes('`mica_contacts`')).length;

/** The numbers on a phone, in insert order, every status. */
const numbersOn = (deviceId: string) =>
  contactRows.filter((row) => row.device_id === deviceId).map((row) => row.phone);

const hold = () => {
  let release!: () => void;
  gates.push(new Promise<void>((resolve) => (release = resolve)));
  return release;
};

/** The columns and values of an INSERT, as a record. */
const inserted = (sql: string, values: unknown[]): Record<string, unknown> => {
  const columns = /\(([^)]*)\) VALUES/
    .exec(sql)![1]
    .split(',')
    .map((column) => column.trim().replace(/`/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
};

beforeEach(() => {
  // MICA-430: a versioned write, through this suite's own stand-in.
  versionedWrites(dbMock);
  vi.clearAllMocks();
  __resetDeviceState();
  __resetOwnerConfig();
  for (const key of Object.keys(convar)) delete convar[key];
  convar.mica_default_contacts = JSON.stringify(SEED);
  contactRows = [];
  phoneRows = [];
  failInsert = new Set();
  insertCount = 0;
  gates = [];
  failMark = 0;
  uniqueKey = false;

  dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (String(sql).includes('`mica_contacts`')) {
      // Honour a status predicate if the read ever grows one, so a read that skipped deleted
      // rows would be caught here rather than answered with every row regardless.
      const activeOnly = /`status`\s*=\s*'active'/.test(String(sql));
      return contactRows
        .filter((row) => row.device_id === params[0])
        .filter((row) => !activeOnly || row.status === 'active')
        .map((row) =>
          String(sql).includes('`default_number`')
            ? { phone: row.phone, default_number: row.default_number ?? null }
            : { phone: row.phone }
        );
    }
    // `mica_devices`: `findAll` by phone id, or `readUnclaimed` by citizen.
    const byPhone = (params as unknown[]).find((value) => /^[0-9a-f]{32}$/.test(String(value)));
    const rows = byPhone
      ? phoneRows.filter((row) => row.device_id === byPhone)
      : phoneRows.filter((row) => row.citizenid === params[0] && !row.claimed);
    return rows.map((row) => ({ ...row, status: 'active' }));
  });
  dbMock.insert.mockImplementation(async (sql: string, values: unknown[]) => {
    if (String(sql).includes('`mica_devices`')) {
      const row = inserted(String(sql), values);
      phoneRows.push({
        id: phoneRows.length + 1,
        device_id: String(row.device_id),
        citizenid: String(row.citizenid),
        claimed: Number(row.claimed),
        // `DEFAULT 0`, as the column is declared.
        setup_pending: Number(row.setup_pending ?? 0)
      });
      return phoneRows.length;
    }
    if (!String(sql).includes('`mica_contacts`')) return 1;
    const position = ++insertCount;
    const gate = gates.shift();
    if (gate) await gate;
    if (failInsert.delete(position)) {
      throw oxmysqlError(String(sql), values, 'Lock wait timeout exceeded');
    }
    const row = inserted(String(sql), values);
    // `device_phone_unique` over (device_id, phone_key): one live row per number on a phone.
    if (
      uniqueKey &&
      contactRows.some(
        (other) =>
          other.device_id === row.device_id &&
          other.status === 'active' &&
          other.phone === row.phone
      )
    ) {
      throw oxmysqlError(
        String(sql),
        values,
        `Duplicate entry '${String(row.device_id)}-${String(row.phone)}' for key 'device_phone_unique'`
      );
    }
    contactRows.push({
      id: contactRows.length + 1,
      device_id: String(row.device_id),
      phone: String(row.phone),
      citizenid: String(row.citizenid),
      status: 'active',
      default_number: (row.default_number as string | undefined) ?? null
    });
    return contactRows.length;
  });
  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (flat.startsWith('UPDATE `mica_devices` SET `setup_pending` = 0')) {
      if (failMark > 0) {
        failMark--;
        throw oxmysqlError(flat, params, 'Lock wait timeout exceeded');
      }
      const row = phoneRows.find((candidate) => candidate.device_id === params[0]);
      if (!row || !row.setup_pending) return false;
      row.setup_pending = 0;
      return true;
    }
    // Nothing else here writes a citizenid since MICA-436: say so if something starts to.
    if (/SET `citizenid`/.test(flat)) throw new Error(`a phone's rows moved: ${flat}`);
    return true;
  });
  dbMock.single.mockResolvedValue(null);
  bridgeMock.getPlayer.mockImplementation((src: number) =>
    src === SRC_B
      ? { citizenid: CID_B, source: SRC_B, setMeta: vi.fn() }
      : { citizenid: CID, source: SRC, setMeta: vi.fn() }
  );
  bridgeMock.setItemMetadata.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a default-contacts seed that fails part-way (MICA-327)', () => {
  it('is finished by the next resolve of the phone, each default once', async () => {
    failInsert.add(3);

    const deviceId = await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId), 'the third insert threw, and the rest were not tried').toEqual([
      '911',
      '555-0100'
    ]);

    await expect(identityPhone(CID)).resolves.toBe(deviceId);
    await settle();
    expect(numbersOn(deviceId)).toEqual(SEED.map((entry) => entry.number));
    expect(contactRows.every((row) => row.citizenid === CID)).toBe(true);

    // Finished, so nothing is owed: a later resolve reads and writes nothing.
    const before = { queries: dbMock.query.mock.calls.length, inserts: insertCount };
    await identityPhone(CID);
    await settle();
    expect({ queries: dbMock.query.mock.calls.length, inserts: insertCount }).toEqual(before);
  });

  it('is finished through the phone in hand on a gated server, too', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: CARRIED } }]);
    failInsert.add(2);

    await resolvePhone(SRC);
    await settle();
    expect(numbersOn(CARRIED)).toEqual(['911']);

    await resolvePhone(SRC);
    await settle();
    expect(numbersOn(CARRIED)).toEqual(SEED.map((entry) => entry.number));
  });

  it('does not bring back a default the player deleted before the retry', async () => {
    failInsert.add(3);
    const deviceId = await identityPhone(CID);
    await settle();

    // The player deletes the Mechanic before the retry runs: soft, so the row stays.
    contactRows.find((row) => row.phone === '555-0100')!.status = 'deleted';

    await identityPhone(CID);
    await settle();

    expect(numbersOn(deviceId)).toEqual(SEED.map((entry) => entry.number));
    const mechanic = contactRows.filter((row) => row.phone === '555-0100');
    expect(mechanic).toHaveLength(1);
    expect(mechanic[0].status).toBe('deleted');
  });

  it('does not double a default when resolves overlap a retry', async () => {
    failInsert.add(3);
    const deviceId = await identityPhone(CID);
    await settle();

    // The retry is held on its first insert while two more resolves come in.
    const release = hold();
    await identityPhone(CID);
    await settle();
    await identityPhone(CID);
    await identityPhone(CID);
    await settle();
    release();
    await settle();

    expect(numbersOn(deviceId)).toEqual(SEED.map((entry) => entry.number));
  });

  it('counts a number the player saved in another format as the default it matches', async () => {
    failInsert.add(2); // the Mechanic, `555-0100`
    const deviceId = await identityPhone(CID);
    await settle();

    // Before the retry, the player saves the Mechanic themselves, without the dash.
    contactRows.push({
      id: contactRows.length + 1,
      device_id: deviceId,
      phone: '5550100',
      citizenid: CID,
      status: 'active'
    });

    await identityPhone(CID);
    await settle();

    expect(numbersOn(deviceId)).toEqual(['911', '5550100', '555-0101', '555-0102', '555-0103']);
  });

  /**
   * MICA-436: a phone is its first user's for good. Somebody else resolving it while a seed is
   * running, or queued, is refused it, and every default lands with the owner it was for.
   */
  describe('against somebody else holding the phone (MICA-436)', () => {
    beforeEach(() => {
      convar.mica_phone_item = 'phone';
      bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: CARRIED } }]);
    });

    /** Every default on the phone, and the phone row, name the owner. */
    const allOwnedBy = (citizenid: string) => {
      expect(numbersOn(CARRIED)).toEqual(SEED.map((entry) => entry.number));
      expect(contactRows.map((row) => row.citizenid)).toEqual(SEED.map(() => citizenid));
      expect(phoneRows.map((row) => row.citizenid)).toEqual([citizenid]);
    };

    it('refuses them while the first seed runs, and the seed lands with the owner', async () => {
      // The first run's first insert is held, and B resolves the phone meanwhile.
      const release = hold();
      await resolvePhone(SRC);
      await settle();
      const refused = resolvePhone(SRC_B);
      await settle();

      release();
      await expect(refused).resolves.toEqual({ status: 'none' });
      await settle();
      allOwnedBy(CID);
    });

    it('refuses them while a retry runs, and the retry lands with the owner', async () => {
      failInsert.add(3);
      await resolvePhone(SRC);
      await settle();
      expect(numbersOn(CARRIED)).toEqual(['911', '555-0100']);

      // A's retry starts and is held on its first insert; B resolves the phone meanwhile.
      const release = hold();
      await resolvePhone(SRC);
      await settle();
      const refused = resolvePhone(SRC_B);
      await settle();

      release();
      await expect(refused).resolves.toEqual({ status: 'none' });
      await settle();
      allOwnedBy(CID);

      // B is cached as refused: asked again, nothing is read.
      dbMock.query.mockClear();
      await expect(resolvePhone(SRC_B)).resolves.toEqual({ status: 'none' });
      expect(dbMock.query).not.toHaveBeenCalled();
    });

    it('seeds for the owner when a queued retry finally runs behind their refusal', async () => {
      failInsert.add(3);
      await resolvePhone(SRC);
      await settle();

      const again = resolvePhone(SRC);
      const refused = resolvePhone(SRC_B);
      await expect(again).resolves.toMatchObject({ status: 'active' });
      await expect(refused).resolves.toEqual({ status: 'none' });
      await settle();
      allOwnedBy(CID);
    });
  });

  it('backs a seed that keeps failing off, and keeps the phone answering', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    dbMock.insert.mockImplementation(async (sql: string) => {
      if (String(sql).includes('`mica_contacts`')) {
        insertCount++;
        throw new Error('Table is read only');
      }
      return 1;
    });

    const deviceId = await identityPhone(CID);
    await settle();
    await expect(identityPhone(CID)).resolves.toBe(deviceId); // the immediate retry
    await settle();
    expect(insertCount).toBe(2);
    // Each failure says it will retry, which attempt it was, and when the next one is due.
    const said = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(said).toEqual([
      expect.stringContaining("(attempt 1); retrying on the phone's next resolve."),
      expect.stringContaining(
        "(attempt 2); retrying no sooner than 5s from now, on the phone's next resolve."
      )
    ]);

    for (let i = 0; i < 5; i++) await expect(identityPhone(CID)).resolves.toBe(deviceId);
    await settle();
    expect(insertCount, 'inside the wait, no attempt').toBe(2);

    now.mockReturnValue(1_000_000 + 5_000);
    await identityPhone(CID);
    await settle();
    expect(insertCount).toBe(3);
  });
});

/**
 * MICA-335: the debt MICA-327 kept in process memory is on the row now. `setup_pending` is
 * inserted `1`, cleared once every hook has run, and read on the device's first resolve after a
 * start. `restart()` drops every in-process map and keeps the rows, as a restart does.
 */
describe('a set-up a restart interrupted (MICA-335)', () => {
  const seeded = SEED.map((entry) => entry.number);

  it('is marked finished only once every hook has run', async () => {
    failInsert.add(3);
    const deviceId = await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual(['911', '555-0100']);
    expect(pendingOf(deviceId), 'a hook failed, so the row still owes it').toBe(1);

    await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual(seeded);
    expect(pendingOf(deviceId)).toBe(0);
  });

  it('is finished on the first resolve after the restart, each default once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    failInsert.add(3);
    const deviceId = await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual(['911', '555-0100']);

    restart();
    await expect(identityPhone(CID)).resolves.toBe(deviceId);
    await settle();

    expect(numbersOn(deviceId)).toEqual(seeded);
    expect(pendingOf(deviceId)).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringContaining(`phone ${who(deviceId)}'s set-up did not finish`)
    );
  });

  it('is finished through the phone in hand after the restart, too', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: CARRIED } }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    failInsert.add(2);
    await resolvePhone(SRC);
    await settle();
    expect(numbersOn(CARRIED)).toEqual(['911']);

    restart();
    await resolvePhone(SRC);
    await settle();

    expect(numbersOn(CARRIED)).toEqual(seeded);
    expect(pendingOf(CARRIED)).toBe(0);
  });

  it('is left for the owner when somebody else resolves the phone after the restart', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: CARRIED } }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    failInsert.add(3);
    await resolvePhone(SRC);
    await settle();

    // B is refused the phone (MICA-436), and nothing is seeded for them.
    restart();
    await expect(resolvePhone(SRC_B)).resolves.toEqual({ status: 'none' });
    await settle();
    expect(numbersOn(CARRIED)).toEqual(['911', '555-0100']);
    expect(pendingOf(CARRIED)).toBe(1);

    // The owner's next resolve finishes it, under them.
    await resolvePhone(SRC);
    await settle();
    expect(numbersOn(CARRIED)).toEqual(seeded);
    expect(contactRows.map((row) => row.citizenid)).toEqual(seeded.map(() => CID));
    expect(phoneRows.map((row) => row.citizenid)).toEqual([CID]);
  });

  /**
   * The upgrade: every row that existed before the column reads `0` (the additive pass's
   * `DEFAULT 0`), or has no value at all before `micaschema apply` adds it. Neither may run a
   * hook. The `1` row is the positive twin — the same fixture, read the same way, does seed —
   * so the two silent cases are silent because of the flag, not because nothing could run.
   */
  it.each([
    ['set up before (0), seeds nothing', 0, []],
    ['read before the column exists, seeds nothing', undefined, []],
    ['still owed (1), seeds every default', 1, seeded]
  ])('on a phone row %s', async (_label, setup_pending, expected) => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: CARRIED } }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    phoneRows.push({ id: 1, device_id: CARRIED, citizenid: CID, claimed: 1, setup_pending });

    await resolvePhone(SRC);
    await settle();

    expect(numbersOn(CARRIED)).toEqual(expected);
    expect(seedReads()).toBe(expected.length > 0 ? 1 : 0);
    // A later resolve of the same phone does not ask again either way.
    await resolvePhone(SRC);
    await settle();
    expect(seedReads()).toBe(expected.length > 0 ? 1 : 0);
  });

  it.each([
    ['in the same process', false],
    ['across a restart', true]
  ])('does not add a renumbered default again, %s', async (_label, restarts) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    failInsert.add(3);
    const deviceId = await identityPhone(CID);
    await settle();

    // The player renumbers the seeded Mechanic before the retry. The number moves; which
    // default the row is does not.
    contactRows.find((row) => row.phone === '555-0100')!.phone = '555-9999';

    if (restarts) restart();
    await identityPhone(CID);
    await settle();

    expect(numbersOn(deviceId)).toEqual(['911', '555-9999', '555-0101', '555-0102', '555-0103']);
    expect(pendingOf(deviceId)).toBe(0);
  });

  it('takes a number the player saved mid-seed, refused by the key, as the default', async () => {
    uniqueKey = true;
    const error = vi.spyOn(console, 'error');
    // The seed has read the phone (nothing on it) and its first insert is held; meanwhile the
    // player saves the Dispatch number exactly as the default has it.
    const release = hold();
    const deviceId = await identityPhone(CID);
    await settle();
    contactRows.push({
      id: contactRows.length + 1,
      device_id: deviceId,
      phone: '911',
      citizenid: CID,
      status: 'active',
      default_number: null
    });
    release();
    await settle();

    expect(numbersOn(deviceId)).toEqual(seeded);
    expect(contactRows.find((row) => row.phone === '911')?.default_number).toBeNull();
    // Not a failure: nothing logged, nothing owed.
    expect(error).not.toHaveBeenCalled();
    expect(pendingOf(deviceId)).toBe(0);
  });

  it('reads only the driver message: a failure whose parameters say "Duplicate entry" still fails', async () => {
    // The default's own name lands in the error's parameter line. Classifying the whole text
    // would take this lock wait for a duplicate and lose the default for good.
    convar.mica_default_contacts = JSON.stringify([
      { name: "Duplicate entry '1' for key 'x'", number: '555-0177' }
    ]);
    failInsert.add(1);
    const deviceId = await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual([]);
    expect(pendingOf(deviceId)).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain(
      "new-phone hook 'defaultContacts' failed"
    );

    await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual(['555-0177']);
    expect(pendingOf(deviceId)).toBe(0);
  });

  it('writes a mark that failed to land again, without running the hooks again', async () => {
    failMark = 1;
    const deviceId = await identityPhone(CID);
    await settle();
    expect(numbersOn(deviceId)).toEqual(seeded);
    expect(pendingOf(deviceId)).toBe(1);
    expect(vi.mocked(console.error).mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining(`phone ${who(deviceId)}'s set-up finished, but could not be recorded`)
    ]);
    const reads = seedReads();

    await identityPhone(CID);
    await settle();
    expect(pendingOf(deviceId)).toBe(0);
    expect(seedReads(), 'the hooks are not run again for a mark').toBe(reads);
  });
});
