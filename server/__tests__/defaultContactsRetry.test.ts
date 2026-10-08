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

import { __resetPhoneState, identityPhone, resolvePhone } from '../services/Phones';
// Registers the seeding hook, which is the thing under test.
import '../services/Contacts';
import { __resetOwnerConfig } from '../lib/ownerConfig';

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
  phone_id: string;
  phone: string;
  citizenid: string;
  status: string;
};
let contactRows: ContactRow[];
type PhoneRow = { id: number; phone_id: string; citizenid: string; claimed: number };
let phoneRows: PhoneRow[];
/** Gates a table's next handover transfer waits on, in order. */
let transferGates: Record<string, Promise<void>[]>;
/** Each contacts insert, by its position across the whole case, that throws (once). */
let failInsert: Set<number>;
let insertCount: number;
/** Gates the next contacts insert waits on, in order. */
let gates: Promise<void>[];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The numbers on a phone, in insert order, every status. */
const numbersOn = (phoneId: string) =>
  contactRows.filter((row) => row.phone_id === phoneId).map((row) => row.phone);

const hold = () => {
  let release!: () => void;
  gates.push(new Promise<void>((resolve) => (release = resolve)));
  return release;
};

/** Hold a table's next handover transfer open until the test lets it through. */
const holdTransfer = (table: string) => {
  let release!: () => void;
  (transferGates[table] ??= []).push(new Promise<void>((resolve) => (release = resolve)));
  return release;
};

const TRANSFER =
  /^UPDATE `(mica_\w+)` SET `citizenid` = \?.* WHERE `phone_id` = \? AND `citizenid` <> \?$/;

/** The columns and values of an INSERT, as a record. */
const inserted = (sql: string, values: unknown[]): Record<string, unknown> => {
  const columns = /\(([^)]*)\) VALUES/
    .exec(sql)![1]
    .split(',')
    .map((column) => column.trim().replace(/`/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetPhoneState();
  __resetOwnerConfig();
  for (const key of Object.keys(convar)) delete convar[key];
  convar.mica_default_contacts = JSON.stringify(SEED);
  contactRows = [];
  phoneRows = [];
  transferGates = {};
  failInsert = new Set();
  insertCount = 0;
  gates = [];

  dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (String(sql).includes('`mica_contacts`')) {
      // Honour a status predicate if the read ever grows one, so a read that skipped deleted
      // rows would be caught here rather than answered with every row regardless.
      const activeOnly = /`status`\s*=\s*'active'/.test(String(sql));
      return contactRows
        .filter((row) => row.phone_id === params[0])
        .filter((row) => !activeOnly || row.status === 'active')
        .map((row) => ({ phone: row.phone }));
    }
    // `mica_phones`: `findAll` by phone id, or `readUnclaimed` by citizen.
    const byPhone = (params as unknown[]).find((value) => /^[0-9a-f]{32}$/.test(String(value)));
    const rows = byPhone
      ? phoneRows.filter((row) => row.phone_id === byPhone)
      : phoneRows.filter((row) => row.citizenid === params[0] && !row.claimed);
    return rows.map((row) => ({ ...row, status: 'active' }));
  });
  dbMock.insert.mockImplementation(async (sql: string, values: unknown[]) => {
    if (String(sql).includes('`mica_phones`')) {
      const row = inserted(String(sql), values);
      phoneRows.push({
        id: phoneRows.length + 1,
        phone_id: String(row.phone_id),
        citizenid: String(row.citizenid),
        claimed: Number(row.claimed)
      });
      return phoneRows.length;
    }
    if (!String(sql).includes('`mica_contacts`')) return 1;
    const position = ++insertCount;
    const gate = gates.shift();
    if (gate) await gate;
    if (failInsert.delete(position)) throw new Error('Lock wait timeout exceeded');
    const row = inserted(String(sql), values);
    contactRows.push({
      id: contactRows.length + 1,
      phone_id: String(row.phone_id),
      phone: String(row.phone),
      citizenid: String(row.citizenid),
      status: 'active'
    });
    return contactRows.length;
  });
  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    const match = TRANSFER.exec(String(sql).replace(/\s+/g, ' ').trim());
    if (!match) return true;
    const gate = transferGates[match[1]]?.shift();
    if (gate) await gate;
    const [to, phone] = params as string[];
    const rows: { phone_id: string; citizenid: string }[] =
      match[1] === 'mica_contacts' ? contactRows : match[1] === 'mica_phones' ? phoneRows : [];
    let moved = 0;
    for (const row of rows) {
      if (row.phone_id === phone && row.citizenid !== to) {
        row.citizenid = to;
        moved++;
      }
    }
    return moved > 0;
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

    const phoneId = await identityPhone(CID);
    await settle();
    expect(numbersOn(phoneId), 'the third insert threw, and the rest were not tried').toEqual([
      '911',
      '555-0100'
    ]);

    await expect(identityPhone(CID)).resolves.toBe(phoneId);
    await settle();
    expect(numbersOn(phoneId)).toEqual(SEED.map((entry) => entry.number));
    expect(contactRows.every((row) => row.citizenid === CID)).toBe(true);

    // Finished, so nothing is owed: a later resolve reads and writes nothing.
    const before = { queries: dbMock.query.mock.calls.length, inserts: insertCount };
    await identityPhone(CID);
    await settle();
    expect({ queries: dbMock.query.mock.calls.length, inserts: insertCount }).toEqual(before);
  });

  it('is finished through the phone in hand on a gated server, too', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);
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
    const phoneId = await identityPhone(CID);
    await settle();

    // The player deletes the Mechanic before the retry runs: soft, so the row stays.
    contactRows.find((row) => row.phone === '555-0100')!.status = 'deleted';

    await identityPhone(CID);
    await settle();

    expect(numbersOn(phoneId)).toEqual(SEED.map((entry) => entry.number));
    const mechanic = contactRows.filter((row) => row.phone === '555-0100');
    expect(mechanic).toHaveLength(1);
    expect(mechanic[0].status).toBe('deleted');
  });

  it('does not double a default when resolves overlap a retry', async () => {
    failInsert.add(3);
    const phoneId = await identityPhone(CID);
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

    expect(numbersOn(phoneId)).toEqual(SEED.map((entry) => entry.number));
  });

  it('counts a number the player saved in another format as the default it matches', async () => {
    failInsert.add(2); // the Mechanic, `555-0100`
    const phoneId = await identityPhone(CID);
    await settle();

    // Before the retry, the player saves the Mechanic themselves, without the dash.
    contactRows.push({
      id: contactRows.length + 1,
      phone_id: phoneId,
      phone: '5550100',
      citizenid: CID,
      status: 'active'
    });

    await identityPhone(CID);
    await settle();

    expect(numbersOn(phoneId)).toEqual(['911', '5550100', '555-0101', '555-0102', '555-0103']);
  });

  describe('against a handover', () => {
    beforeEach(() => {
      convar.mica_phone_item = 'phone';
      bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);
    });

    /** Every contact on the phone, and the phone row, name this citizen. */
    const allHeldBy = (citizenid: string) => {
      expect(numbersOn(CARRIED)).toEqual(SEED.map((entry) => entry.number));
      expect(contactRows.map((row) => row.citizenid)).toEqual(SEED.map(() => citizenid));
      expect(phoneRows.map((row) => row.citizenid)).toEqual([citizenid]);
    };

    it('finishes the first seed before the next holder is handed the phone', async () => {
      // The same race on the first run: its first insert is held, and B takes the phone.
      const release = hold();
      await resolvePhone(SRC);
      await settle();
      const handedOver = resolvePhone(SRC_B);
      await settle();

      release();
      await handedOver;
      await settle();
      allHeldBy(CID_B);
    });

    it('finishes a retry already running before the next holder is handed the phone', async () => {
      failInsert.add(3);
      await resolvePhone(SRC);
      await settle();
      expect(numbersOn(CARRIED)).toEqual(['911', '555-0100']);

      // A's retry starts and is held on its first insert; B takes the phone meanwhile.
      const release = hold();
      await resolvePhone(SRC);
      await settle();
      const handedOver = resolvePhone(SRC_B);
      await settle();

      release();
      await expect(handedOver).resolves.toMatchObject({ status: 'active' });
      await settle();
      // The retry wrote A's rows before B's walk ran, and the walk moved them with the rest.
      allHeldBy(CID_B);

      // B is cached with nothing left behind.
      dbMock.query.mockClear();
      await resolvePhone(SRC_B);
      await settle();
      expect(dbMock.query).not.toHaveBeenCalled();
    });

    it('seeds for whoever holds the phone when a queued retry finally runs', async () => {
      failInsert.add(3);
      await resolvePhone(SRC);
      await settle();

      // A's resolve is queued first and cached; B's walk queues behind it and is held mid-way.
      const release = holdTransfer('mica_contacts');
      const again = resolvePhone(SRC);
      const handedOver = resolvePhone(SRC_B);
      await settle();

      release();
      await Promise.all([again, handedOver]);
      await settle();
      // Queue order: A's cached resolve, then B's walk, then the retry A's resolve queued once
      // it was answered. So B holds the phone when the retry runs, and its rows name B — not
      // A, who asked for it, which would leave them behind with B cached.
      allHeldBy(CID_B);
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

    const phoneId = await identityPhone(CID);
    await settle();
    await expect(identityPhone(CID)).resolves.toBe(phoneId); // the immediate retry
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

    for (let i = 0; i < 5; i++) await expect(identityPhone(CID)).resolves.toBe(phoneId);
    await settle();
    expect(insertCount, 'inside the wait, no attempt').toBe(2);

    now.mockReturnValue(1_000_000 + 5_000);
    await identityPhone(CID);
    await settle();
    expect(insertCount).toBe(3);
  });
});
