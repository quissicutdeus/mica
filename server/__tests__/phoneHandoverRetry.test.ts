// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, bridgeMock } = vi.hoisted(() => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_phone_item' ? 'phone' : fallback;
  (globalThis as any).on = () => {};
  (globalThis as any).onNet = () => {};
  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    bridgeMock: {
      getPlayer: vi.fn(),
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1),
      forgetSource: vi.fn(),
      rememberSource: vi.fn()
    }
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qbx'
}));

import { onPhoneHandover, phoneForRequest, __resetPhoneState } from '../services/Phones';
import { defineService } from '../lib/defineService';
import { __resetLastUsedPhone } from '../lib/deviceItem';

/**
 * A handover that fails part-way is retried, not cached as done (MICA-319).
 *
 * The database is a few rows in memory, and every `transferPhoneRows` statement is applied to
 * them for real, so "the rows land with the new holder" is a row's `citizenid`, not a call
 * count. `mica_handover_probe` is a second phone-keyed table beside `mica_phones`, declared
 * here so the handover walks two: one that can fail while the other moves.
 */
defineService({
  id: 'handover_probe',
  table: 'mica_handover_probe',
  deviceOwned: true,
  access: { read: 'owner', write: 'server' },
  schema: { body: { type: 'string', length: 20 } },
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
});

const PHONE = 'a'.repeat(32);
const VICTIM = 'VIC00001';
const THIEF = 'THF00002';
const FENCE = 'FNC00003';
const VICTIM_SRC = 1;
const THIEF_SRC = 2;
const FENCE_SRC = 3;

type Row = { id: number; phone_id: string; citizenid: string; claimed?: number };
let tables: Record<string, Row[]>;
/** Each table's transfer throws this many more times before it works. */
let failuresLeft: Record<string, number>;
/** Every transfer statement attempted, by table, whether it threw or not. */
let attempts: Record<string, number>;
/** Gates a table's next transfer waits on, in order: see `hold`. */
let gates: Record<string, Promise<void>[]>;
/** Every read's SQL, checked after each case rather than inside the mock, where a throw is swallowed. */
let reads: string[];

const TRANSFER =
  /^UPDATE `(mica_\w+)` SET `citizenid` = \?.* WHERE `phone_id` = \? AND `citizenid` <> \?$/;

const holders = (table: string) => tables[table].map((row) => row.citizenid);

/** What every transfer does: rows on the phone not naming the new holder now name them. */
const moveRows = (table: string, phone: string, to: string): boolean => {
  let moved = 0;
  for (const row of tables[table] ?? []) {
    if (row.phone_id === phone && row.citizenid !== to) {
      row.citizenid = to;
      moved++;
    }
  }
  return moved > 0;
};

/**
 * A child table moved by a hook rather than the repository walk, the way
 * `mica_messages_participants` is, and answering whether it moved anything, as that does.
 */
onPhoneHandover('participants_probe', (phone, to) => moveRows('participants', phone, to));

/** Hold a table's next transfer open until the test lets it through or fails it. */
const hold = (table: string) => {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  (gates[table] ??= []).push(gate);
  return { release, fail: () => reject(new Error(`Lock wait timeout exceeded (${table})`)) };
};

/** Let every pending promise chain run as far as it can. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  __resetPhoneState();
  __resetLastUsedPhone();
  tables = {
    mica_phones: [{ id: 1, phone_id: PHONE, citizenid: VICTIM, claimed: 1 }],
    mica_handover_probe: [
      { id: 1, phone_id: PHONE, citizenid: VICTIM },
      { id: 2, phone_id: PHONE, citizenid: VICTIM }
    ],
    participants: [{ id: 1, phone_id: PHONE, citizenid: VICTIM }]
  };
  failuresLeft = {};
  attempts = {};
  gates = {};
  reads = [];

  dbMock.query.mockImplementation(async (sql: string) => {
    reads.push(String(sql));
    return tables.mica_phones.map((row) => ({ ...row, status: 'active' }));
  });
  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    const match = TRANSFER.exec(String(sql).replace(/\s+/g, ' ').trim());
    if (!match) return true;
    const table = match[1];
    attempts[table] = (attempts[table] ?? 0) + 1;
    const gate = gates[table]?.shift();
    if (gate) await gate;
    if ((failuresLeft[table] ?? 0) > 0) {
      failuresLeft[table]--;
      throw new Error(`Lock wait timeout exceeded (${table})`);
    }
    const [to, phone] = params as string[];
    return moveRows(table, phone, to);
  });

  const players: Record<number, { citizenid: string; source: number }> = {
    [VICTIM_SRC]: { citizenid: VICTIM, source: VICTIM_SRC },
    [THIEF_SRC]: { citizenid: THIEF, source: THIEF_SRC },
    [FENCE_SRC]: { citizenid: FENCE, source: FENCE_SRC }
  };
  bridgeMock.getPlayer.mockImplementation((src: number) => players[src]);
  bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: PHONE } }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // `findAll` on `mica_phones` by phone id is the only read this path makes.
  for (const sql of reads) expect(sql).toContain('mica_phones');
});

describe('a handover that fails part-way (MICA-319)', () => {
  it('retries the table that failed on the next request, and moves its rows', async () => {
    failuresLeft.mica_handover_probe = 1;

    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    expect(holders('mica_handover_probe'), 'the failed table is still the victim’s').toEqual([
      VICTIM,
      VICTIM
    ]);
    // Held back with it: `mica_phones` moves only once everything else has.
    expect(holders('mica_phones')).toEqual([VICTIM]);
    // Both lines name the table, so an operator knows which one is stuck.
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes('could not move mica_handover_probe'))).toBe(true);
    expect(
      logged.some((line) => line.includes('but mica_handover_probe, mica_phones still name'))
    ).toBe(true);

    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    expect(holders('mica_handover_probe')).toEqual([THIEF, THIEF]);
    expect(holders('mica_phones')).toEqual([THIEF]);
    // The probe was walked twice and the phone row once, last.
    expect(attempts).toEqual({ mica_phones: 1, mica_handover_probe: 2 });

    // Done now, so it is cached like any finished handover: no read, no statement.
    dbMock.query.mockClear();
    await phoneForRequest(THIEF_SRC, THIEF);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(attempts).toEqual({ mica_phones: 1, mica_handover_probe: 2 });
  });

  it('still walks the table that failed after a restart forgets what was owed', async () => {
    failuresLeft.mica_handover_probe = 1;
    await phoneForRequest(THIEF_SRC, THIEF);
    expect(holders('mica_handover_probe')).toEqual([VICTIM, VICTIM]);

    // A restart: `pendingHandover` and `holderOf` are process memory and gone. The phone row
    // still naming the victim is all that says the handover is unfinished.
    __resetPhoneState();

    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    expect(holders('mica_handover_probe')).toEqual([THIEF, THIEF]);
    expect(holders('mica_phones')).toEqual([THIEF]);
  });

  it('hands back what a thief kept when the owner resolves first after a restart', async () => {
    // The thief's handover moved the hook's table and failed the probe, so the phone row stayed
    // with the victim, held back until everything else moves.
    failuresLeft.mica_handover_probe = 1;
    await phoneForRequest(THIEF_SRC, THIEF);
    expect(holders('participants')).toEqual([THIEF]);
    expect(holders('mica_handover_probe')).toEqual([VICTIM, VICTIM]);
    expect(holders('mica_phones')).toEqual([VICTIM]);

    // A restart, and the phone is back with the victim. The row names them already, so it
    // says nothing is unfinished — but the hook's table still names the thief.
    __resetPhoneState();
    await expect(phoneForRequest(VICTIM_SRC, VICTIM)).resolves.toBe(PHONE);

    expect(holders('participants')).toEqual([VICTIM]);
    expect(holders('mica_handover_probe')).toEqual([VICTIM, VICTIM]);
    expect(holders('mica_phones')).toEqual([VICTIM]);
  });

  it('walks a phone whose rows are all its holder’s once per process, quietly', async () => {
    await expect(phoneForRequest(VICTIM_SRC, VICTIM)).resolves.toBe(PHONE);
    // One statement per table, matching nothing, and no line claiming that rows moved.
    expect(attempts).toEqual({ mica_handover_probe: 1, mica_phones: 1 });
    expect(console.log).not.toHaveBeenCalled();

    dbMock.query.mockClear();
    for (let i = 0; i < 3; i++) await phoneForRequest(VICTIM_SRC, VICTIM);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(attempts).toEqual({ mica_handover_probe: 1, mica_phones: 1 });
  });

  it('keeps the phone usable while a table keeps failing, and backs the retries off', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    failuresLeft.mica_handover_probe = Number.POSITIVE_INFINITY;

    // The handover, then the immediate retry: both fail, both still answer the phone.
    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    expect(attempts.mica_handover_probe).toBe(2);

    // Inside the wait: answered from what is known, with no query and no statement.
    dbMock.query.mockClear();
    for (let i = 0; i < 5; i++) {
      await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    }
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(attempts.mica_handover_probe).toBe(2);

    // Past it, one more try.
    now.mockReturnValue(1_000_000 + 5_000);
    await expect(phoneForRequest(THIEF_SRC, THIEF)).resolves.toBe(PHONE);
    expect(attempts.mica_handover_probe).toBe(3);
    // Never attempted: the phone row waits for the probe.
    expect(attempts.mica_phones).toBeUndefined();
    expect(holders('mica_phones')).toEqual([VICTIM]);
  });

  it('walks every table when the phone goes back while a handover is still owed', async () => {
    // To the thief, but the `mica_phones` row is the table that fails, so it still names the
    // victim while the probe rows moved. Reading that row alone would call the phone the
    // victim's already and leave the probe with the thief.
    failuresLeft.mica_phones = 1;
    await phoneForRequest(THIEF_SRC, THIEF);
    expect(holders('mica_phones')).toEqual([VICTIM]);
    expect(holders('mica_handover_probe')).toEqual([THIEF, THIEF]);

    await expect(phoneForRequest(VICTIM_SRC, VICTIM)).resolves.toBe(PHONE);
    expect(holders('mica_phones')).toEqual([VICTIM]);
    expect(holders('mica_handover_probe')).toEqual([VICTIM, VICTIM]);
  });

  it('runs two overlapping requests for one phone one after the other', async () => {
    const probe = hold('mica_handover_probe');

    const first = phoneForRequest(THIEF_SRC, THIEF);
    const second = phoneForRequest(THIEF_SRC, THIEF);
    await flush();
    // The first is mid-walk; the second has not read the phone row yet.
    expect(dbMock.query).toHaveBeenCalledOnce();

    probe.release();
    await expect(first).resolves.toBe(PHONE);
    await expect(second).resolves.toBe(PHONE);
    // The second found the handover finished and cached: no read and no walk of its own.
    expect(dbMock.query).toHaveBeenCalledOnce();
    expect(attempts).toEqual({ mica_handover_probe: 1, mica_phones: 1 });
    expect(holders('mica_handover_probe')).toEqual([THIEF, THIEF]);
  });

  it('does not let a retry that was overtaken overwrite what replaced it', async () => {
    failuresLeft.mica_handover_probe = 1;
    await phoneForRequest(THIEF_SRC, THIEF);

    // The thief's retry starts and is held mid-walk.
    const probe = hold('mica_handover_probe');
    const retry = phoneForRequest(THIEF_SRC, THIEF);
    await flush();
    expect(attempts.mica_handover_probe).toBe(2);

    // Requests alone cannot overtake it now, since calls for one phone queue. The seam stands
    // in for whatever would: what it was owed is forgotten, and a third holder's full handover
    // runs to the end while the retry is still out.
    __resetPhoneState();
    await expect(phoneForRequest(FENCE_SRC, FENCE)).resolves.toBe(PHONE);
    expect(holders('mica_handover_probe')).toEqual([FENCE, FENCE]);
    expect(holders('mica_phones')).toEqual([FENCE]);

    // The stale retry fails. What it left is the thief's, and must not land over the fence's
    // finished handover — neither as a debt owed to the thief nor by un-caching the fence.
    probe.fail();
    await retry;

    dbMock.query.mockClear();
    await expect(phoneForRequest(FENCE_SRC, FENCE)).resolves.toBe(PHONE);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(holders('mica_handover_probe')).toEqual([FENCE, FENCE]);
  });
});
