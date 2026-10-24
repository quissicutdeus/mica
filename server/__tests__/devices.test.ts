// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const { dbMock, bridgeMock, framework, handlers } = vi.hoisted(() => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_phone_item' ? 'phone' : fallback;
  // Every handler per event, not the last: `deviceItem.ts` and `Devices.ts` both listen for
  // `playerDropped`, and a Map that kept one would test whichever registered second.
  const captured = new Map<string, Function[]>();
  const capture = (event: string, handler: Function) => {
    captured.set(event, [...(captured.get(event) ?? []), handler]);
  };
  (globalThis as any).on = capture;
  (globalThis as any).onNet = capture;

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
      registerUsableItem: vi.fn(),
      // How many of an item a player holds. No slot reader exists here at all (MICA-438): a
      // resolve that asked for one would throw.
      countItem: vi.fn((_player: unknown, _item: string): number | null => 1),
      // `lib/shell.ts` also listens for `playerDropped`, and this suite fires every listener.
      forgetSource: vi.fn(),
      rememberSource: vi.fn(),
      // MICA-440: who is on a source, and the owner table a phone's create asks after.
      getSourceByCitizenId: vi.fn((_citizenid: string): number | null => null),
      ownerTable: vi.fn(() => ({ table: 'players', column: 'citizenid' }))
    },
    framework: { kind: 'qb' as string },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => framework.kind
}));

import { __resetCreateVerdictForTests } from '../lib/orphanSweep';
import {
  activeDeviceIdOf,
  activePhone,
  activePhoneIdOf,
  identityPhone,
  phoneForCitizen,
  deviceForRequest,
  devices,
  requireDeviceInHand,
  resolveDevice,
  resolvePhone,
  __resetDeviceState
} from '../services/Devices';
import { __resetPhoneItemWarnings, evaluateDeviceItems } from '../lib/deviceItem';
import { __setDeviceResolvers } from '../lib/deviceIdentity';
import { countInventoryItem, __setResourceLookup } from '../lib/framework/runtime';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { defineContract } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import { __resetLockState, isDeviceLocked, setDeviceLocked } from '../lib/LockState';
import { who } from '../lib/who';
import { versionedWrites, type VersionedCall } from './versionedWrites';

/**
 * A character has exactly one phone and one tablet (MICA-438): their `mica_devices` row of that
 * kind. A phone item is a key, not a phone — holding any copy opens the holder's own phone, and
 * nothing is read from an item or written to one. These drive the real resolver with only the
 * database and the framework mocked.
 */

/** The versioned writes this test made (MICA-430). */
let versionCalls: VersionedCall[] = [];

/**
 * `deviceItem.ts` registers its usable-item callback at import time, and `clearAllMocks` wipes
 * the call that recorded it — so it is taken here, once, while it is still there.
 */
const usePhoneItem: (src: number, used?: { slot?: unknown }) => void =
  bridgeMock.registerUsableItem.mock.calls.find((call: unknown[]) => call[0] === 'phone')?.[1];

const SRC = 7;
const CID = 'ABC12345';
const SRC_B = 8;
const CID_B = 'BBB22222';
const ID_SHAPE = /^[0-9a-f]{32}$/;
const A_PHONE = 'a'.repeat(32);
const A_TABLET = 'd'.repeat(32);

const player = { citizenid: CID, source: SRC, setMeta: vi.fn(), rawPlayer: {} };
const playerB = { citizenid: CID_B, source: SRC_B, setMeta: vi.fn(), rawPlayer: {} };

/** A `mica_devices` row as the identity read selects it. */
const device = (citizenid: string, deviceId: string, kind = 'phone', id = 1) => ({
  id,
  citizenid,
  device_id: deviceId,
  kind,
  setup_pending: 0,
  status: 'active'
});

/** Each citizen's rows by kind, newest first, as the identity read answers them. */
const rowsOf = (rows: Record<string, ReturnType<typeof device>[]>) => {
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (!String(sql).includes('`mica_devices`')) return [];
    return (rows[String(params[0])] ?? []).filter((row) => row.kind === params[1]);
  });
};

/** The identity reads this test made: whose, and of which kind. */
const identityReads = () =>
  dbMock.query.mock.calls
    .filter(([sql]) => String(sql).includes('`mica_devices`'))
    .map(([, params]) => params as unknown[]);

/** Each INSERT into `mica_devices`, as a column-to-value record. */
const deviceInserts = (): Record<string, unknown>[] =>
  dbMock.insert.mock.calls
    .filter(([sql]) => String(sql).includes('INTO `mica_devices`'))
    .map(([sql, values]) => {
      const columns = /\(([^)]*)\) VALUES/
        .exec(String(sql))![1]
        .split(',')
        .map((column) => column.trim().replace(/`/g, ''));
      return Object.fromEntries(columns.map((column, i) => [column, (values as unknown[])[i]]));
    });

/** `mica_phone_item` and `mica_tablet_item`; empty means no gate. */
const gate = (phone = 'phone', tablet = '') => {
  globalThis.GetConvar = ((name: string, fallback: string) =>
    name === 'mica_phone_item' ? phone : name === 'mica_tablet_item' ? tablet : fallback) as any;
};

const dropSource = (src: number) => {
  (globalThis as any).source = src;
  for (const dropped of handlers.get('playerDropped')!) dropped();
};

beforeEach(() => {
  // MICA-430: a versioned write, through this suite's own stand-in.
  versionCalls = versionedWrites(dbMock);
  vi.clearAllMocks();
  __resetDeviceState();
  __resetPhoneItemWarnings();
  globalThis.emitNet = vi.fn() as any;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  bridgeMock.getPlayer.mockImplementation((src: number) => (src === SRC_B ? playerB : player));
  bridgeMock.countItem.mockReturnValue(1);
  // Both characters are loaded, so a create for either asks no owner table (MICA-440).
  bridgeMock.getSourceByCitizenId.mockImplementation((citizenid: string) =>
    citizenid === CID ? SRC : citizenid === CID_B ? SRC_B : null
  );
  framework.kind = 'qb';
  gate();
});

describe('the devices table declaration', () => {
  it('is server-authored, so no column is client-writable', () => {
    expect(devices.repo.writableColumns).toEqual([]);
  });

  it('declares kind over every device, defaulting to the phone, and no client writes it', () => {
    const kind = devices.resolved.fields.find((f) => f.name === 'kind');
    expect(kind?.def).toMatchObject({
      type: 'enum',
      values: ['phone', 'tablet'],
      notNull: true,
      default: 'phone',
      clientWritable: false
    });
  });

  it('keeps device_id unique, and adds no unique key on the citizen (no schema change)', () => {
    const unique = devices.resolved.indexes.filter((i) => i.unique).map((i) => i.name);
    expect(unique).toEqual(['device_id_unique']);
  });

  it('keeps `claimed` declared, defaulted, and written by nothing (MICA-438)', async () => {
    const claimed = devices.resolved.fields.find((f) => f.name === 'claimed');
    expect(claimed?.def).toMatchObject({ type: 'bool', notNull: true, default: 0 });

    await identityPhone(CID);
    expect(deviceInserts()).toHaveLength(1);
    expect(Object.keys(deviceInserts()[0])).not.toContain('claimed');
    for (const [sql] of dbMock.query.mock.calls) expect(String(sql)).not.toContain('`claimed`');
  });
});

/**
 * MICA-438: the citizen's row of the kind asked for, held by count on a gated server.
 */
describe('one phone per character (MICA-438)', () => {
  it("resolves the holder's own row by count, reading it once and writing nothing", async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    await expect(resolvePhone(SRC)).resolves.toEqual({
      status: 'active',
      device: { deviceId: A_PHONE }
    });
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);

    expect(bridgeMock.countItem).toHaveBeenCalledWith(player, 'phone');
    expect(identityReads()).toEqual([[CID, 'phone']]);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(versionCalls).toEqual([]);
  });

  it('reads live rows only, newest first by updated_at then id', async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    await identityPhone(CID);

    const [sql] = dbMock.query.mock.calls.find(([q]) => String(q).includes('`mica_devices`'))!;
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain("`status` = 'active'");
    expect(flat).toContain('`citizenid` = ? AND `kind` = ?');
    expect(flat).toContain('ORDER BY `updated_at` DESC, `id` DESC');
  });

  it('creates the row the first time, once, however many asks overlap', async () => {
    const answers = await Promise.all([
      deviceForRequest(SRC, CID),
      deviceForRequest(SRC, CID),
      phoneForCitizen(CID),
      identityPhone(CID)
    ]);

    expect(answers[0]).toMatch(ID_SHAPE);
    expect(new Set(answers).size).toBe(1);
    expect(identityReads()).toHaveLength(1);
    // `setup_pending` is owed until the new-device hooks run (MICA-335); `claimed` is not written.
    expect(deviceInserts()).toEqual([
      { citizenid: CID, device_id: answers[0], kind: 'phone', setup_pending: 1 }
    ]);
  });

  /**
   * The item is a key. Whatever a copy carries — nothing, a stale id from MICA-219..436, or the
   * id of somebody else's phone — and whichever inventory holds it, the holder resolves to their
   * own row. Driven through the real `countInventoryItem`, with each inventory's own shape.
   */
  describe('the same phone from any phone item, on every inventory shape', () => {
    const STALE = 'e'.repeat(32);
    const SOMEBODY_ELSES = 'f'.repeat(32);
    const carrying = [{}, { deviceId: STALE }, { deviceId: SOMEBODY_ELSES }, { deviceId: 'junk' }];

    beforeEach(() => {
      rowsOf({ [CID]: [device(CID, A_PHONE)] });
      bridgeMock.countItem.mockImplementation((p: any, item: string) =>
        countInventoryItem(p.source, p.rawPlayer, item)
      );
    });

    afterEach(() => {
      __setResourceLookup();
    });

    const resolvesOwn = async (rawPlayer: unknown) => {
      __resetDeviceState();
      bridgeMock.getPlayer.mockReturnValue({ ...player, rawPlayer });
      await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    };

    it('ox_inventory, slot metadata or not', async () => {
      for (const metadata of carrying) {
        const GetSlotsWithItem = vi.fn(() => [{ slot: 3, metadata }]);
        const GetItemCount = vi.fn(() => 1);
        __setResourceLookup((name) =>
          name === 'ox_inventory' ? { GetItemCount, GetSlotsWithItem } : undefined
        );
        await resolvesOwn({});
        expect(GetItemCount).toHaveBeenCalledWith(SRC, 'phone');
        expect(GetSlotsWithItem).not.toHaveBeenCalled();
      }
    });

    it("a qb player's item, info or not", async () => {
      __setResourceLookup(() => undefined);
      for (const info of carrying) {
        await resolvesOwn({
          PlayerData: { citizenid: CID },
          Functions: { GetItemByName: () => ({ name: 'phone', amount: 1, slot: 4, info }) }
        });
      }
    });

    it("an ESX xPlayer's item, which carries nothing", async () => {
      __setResourceLookup(() => undefined);
      await resolvesOwn({ PlayerData: {}, xPlayer: { getInventoryItem: () => ({ count: 1 }) } });
    });

    afterEach(() => {
      // Read by the holder's citizenid alone, and nothing written, on every shape.
      for (const params of identityReads()) expect(params).toEqual([CID, 'phone']);
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
    });
  });

  it('never puts two characters on one row', async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    const a = await deviceForRequest(SRC, CID);
    const b = await deviceForRequest(SRC_B, CID_B);

    expect(a).toBe(A_PHONE);
    expect(b).toMatch(ID_SHAPE);
    expect(b).not.toBe(A_PHONE);
    expect(identityReads()).toEqual([
      [CID, 'phone'],
      [CID_B, 'phone']
    ]);
    expect(deviceInserts()).toEqual([
      { citizenid: CID_B, device_id: b, kind: 'phone', setup_pending: 1 }
    ]);
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);
    expect(activePhoneIdOf(SRC_B)).toBe(b);
  });

  /**
   * A thief with the victim's phone item in hand opens the thief's own phone: their own rows,
   * their own number. Nothing of the victim's is read, and nothing of theirs is written; rows
   * filed for the victim meanwhile wait on the victim's phone, which a new item opens again.
   */
  it("resolves a thief holding the victim's item to the thief's own phone, and touches nothing", async () => {
    const THIEFS = 'b'.repeat(32);
    rowsOf({ [CID]: [device(CID, A_PHONE)], [CID_B]: [device(CID_B, THIEFS)] });
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    dbMock.query.mockClear();

    // The victim's item, carrying the victim's old id, is in the thief's inventory now; the
    // victim holds none.
    bridgeMock.countItem.mockImplementation((p: any) => (p.citizenid === CID_B ? 1 : 0));
    playerB.rawPlayer = { Functions: { GetItemByName: () => ({ info: { deviceId: A_PHONE } }) } };
    try {
      await expect(deviceForRequest(SRC_B, CID_B)).resolves.toBe(THIEFS);
      await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({
        key: 'server.phone.notHeld'
      });

      expect(identityReads()).toEqual([[CID_B, 'phone']]);
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(versionCalls).toEqual([]);
      // The victim's next row still lands on the victim's phone, for when they have one again.
      await expect(phoneForCitizen(CID)).resolves.toBe(A_PHONE);
      // And a new item in the victim's hand opens it, everything on it.
      bridgeMock.countItem.mockReturnValue(1);
      await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    } finally {
      playerB.rawPlayer = {};
    }
  });

  it('refuses a player holding none on a gated server, in words they can read, and reads nothing', async () => {
    bridgeMock.countItem.mockReturnValue(0);

    await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.phone.notHeld'
    });
    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'none' });
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("answers the citizen's phone with no count on a server with no phone item", async () => {
    gate('');
    bridgeMock.countItem.mockReturnValue(0);
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'unavailable' });
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);
  });

  it('fails open where no inventory can count, onto the same phone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridgeMock.countItem.mockReturnValue(null);
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    warn.mockRestore();
  });

  it('takes the most recent of several rows, and says so once, by token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const NEWER = '7'.repeat(32);
    const OLDER = '6'.repeat(32);
    // Newest first, as the read's ORDER BY answers them.
    rowsOf({ [CID]: [device(CID, NEWER, 'phone', 9), device(CID, OLDER, 'phone', 3)] });

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(NEWER);
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(NEWER);
    await expect(phoneForCitizen(CID)).resolves.toBe(NEWER);

    const said = warn.mock.calls.map(([line]) => String(line));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`${who(CID)} has 2 phone rows`);
    expect(said[0]).toContain(`using ${who(NEWER)}`);
    expect(said[0]).not.toContain(CID);
    expect(said[0]).not.toContain(NEWER);
    // The older row is left as it is: nothing merged, moved or retired.
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads a database micaschema apply has not given setup_pending yet, as set up', async () => {
    // MariaDB refuses a statement naming a column the table does not have (MICA-335's column,
    // before the additive pass adds it). The row then has no value at all, which reads as
    // finished: nothing is owed, so nothing runs and nothing is written.
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes('`setup_pending`')) {
        throw new Error("Unknown column 'setup_pending' in 'field list'");
      }
      if (!String(sql).includes('`mica_devices`') || params[0] !== CID) return [];
      const { setup_pending: _absent, ...row } = device(CID, A_PHONE);
      return [row];
    });

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('caches nothing when the read fails, and reads again on the next ask', async () => {
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(deviceForRequest(SRC, CID)).rejects.toThrow('connection lost');
    expect(activePhoneIdOf(SRC)).toBeNull();

    rowsOf({ [CID]: [device(CID, A_PHONE)] });
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('caches nothing when the create fails, and creates on the next ask', async () => {
    dbMock.insert.mockRejectedValueOnce(new Error('lock wait timeout'));

    await expect(deviceForRequest(SRC, CID)).rejects.toThrow('lock wait timeout');
    const created = await deviceForRequest(SRC, CID);

    expect(created).toMatch(ID_SHAPE);
    expect(deviceInserts()).toHaveLength(2);
    expect(deviceInserts()[1].device_id).toBe(created);
  });

  it("opens the holder's phone on a use of any copy, with no slot recorded", async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });
    expect(usePhoneItem, 'the phone item registers a usable-item callback').toBeTypeOf('function');

    usePhoneItem(SRC, { slot: 8 });
    usePhoneItem(SRC, { slot: 2 });

    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:open', SRC);
    await expect(activePhone(SRC)).resolves.toEqual({ deviceId: A_PHONE });
  });
});

/**
 * MICA-264: the tablet is a row of its own kind, with none of a phone's reach. It follows by
 * kind exactly as the phone does.
 */
describe('the tablet follows by kind', () => {
  beforeEach(() => {
    gate('phone', 'tablet');
  });

  it("resolves the citizen's own tablet row, created once, apart from the phone", async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    const tablet = await deviceForRequest(SRC, CID, 'tablet');
    const phone = await deviceForRequest(SRC, CID);

    expect(phone).toBe(A_PHONE);
    expect(tablet).toMatch(ID_SHAPE);
    expect(tablet).not.toBe(A_PHONE);
    expect(identityReads()).toEqual([
      [CID, 'tablet'],
      [CID, 'phone']
    ]);
    expect(deviceInserts()).toEqual([
      { citizenid: CID, device_id: tablet, kind: 'tablet', setup_pending: 1 }
    ]);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(tablet);
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);
  });

  it('counts the tablet item for the tablet, and refuses none in words they can read', async () => {
    bridgeMock.countItem.mockImplementation((_p: unknown, item: string) =>
      item === 'phone' ? 1 : 0
    );

    await expect(deviceForRequest(SRC, CID, 'tablet')).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.device.notHeld',
      params: { device: 'Tablet' }
    });
    expect(bridgeMock.countItem).toHaveBeenCalledWith(player, 'tablet');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("never answers a citizen's tablet as their phone", async () => {
    rowsOf({ [CID]: [device(CID, A_TABLET, 'tablet')] });

    await expect(deviceForRequest(SRC, CID, 'tablet')).resolves.toBe(A_TABLET);
    const phone = await phoneForCitizen(CID);
    expect(phone).not.toBe(A_TABLET);
    expect(await identityPhone(CID)).toBe(phone);
    expect(deviceInserts()).toEqual([
      { citizenid: CID, device_id: phone, kind: 'phone', setup_pending: 1 }
    ]);
  });
});

describe('the phone a source is on, synchronously', () => {
  it('is unknown before the first resolve, known after it, and forgotten on a disconnect', async () => {
    expect(activePhoneIdOf(SRC)).toBeNull();
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);

    dropSource(SRC);
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('is cleared when a resolve finds none held, so LockPhone keys the source', async () => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });
    await resolvePhone(SRC);

    bridgeMock.countItem.mockReturnValue(0);
    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'none' });
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('forgets the tablet a source was on at a disconnect', async () => {
    gate('phone', 'tablet');
    rowsOf({ [CID]: [device(CID, A_TABLET, 'tablet')] });

    await deviceForRequest(SRC, CID, 'tablet');
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(A_TABLET);

    dropSource(SRC);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
  });

  /**
   * A cold read yields, and a character switch keeps the source. The previous character's
   * resolve finishing afterwards must not put their device over the new character's entry, or
   * `LockState` and the battery key the wrong phone (Tup, MICA-438 review).
   */
  it('records nothing for a resolve whose source switched character during its read', async () => {
    const NEXT = 'NEW00001';
    const NEXT_PHONE = '9'.repeat(32);
    const next = { ...player, citizenid: NEXT };
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!String(sql).includes('`mica_devices`')) return [];
      if (params[0] === CID) {
        // The switch lands while A's row is being read.
        bridgeMock.getPlayer.mockReturnValue(next);
        return [device(CID, A_PHONE)];
      }
      return params[0] === NEXT ? [device(NEXT, NEXT_PHONE)] : [];
    });

    // A's request still gets A's phone: it is the request's answer to use.
    await expect(deviceForRequest(SRC, CID, 'phone', { player: player as any })).resolves.toBe(
      A_PHONE
    );
    // But the source is NEXT's now, and A's phone is not recorded as theirs.
    expect(activePhoneIdOf(SRC)).toBeNull();

    // The positive twin: NEXT's own resolve records NEXT's phone.
    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBe(NEXT_PHONE);
  });

  /**
   * A disconnect during a cold read clears the source's entries on `playerDropped`; the resolve
   * finishing after must not put one back for a server id FiveM hands to the next player (Tup,
   * MICA-438 review).
   */
  it('records nothing for a resolve whose player left during its read', async () => {
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!String(sql).includes('`mica_devices`') || params[0] !== CID) return [];
      // The player drops while the row is being read.
      bridgeMock.getPlayer.mockReturnValue(null);
      dropSource(SRC);
      return [device(CID, A_PHONE)];
    });

    await expect(deviceForRequest(SRC, CID, 'phone', { player: player as any })).resolves.toBe(
      A_PHONE
    );
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('records nothing for a request on a source nobody is loaded on', async () => {
    gate('');
    bridgeMock.getPlayer.mockReturnValue(null);
    rowsOf({ [CID]: [device(CID, A_PHONE)] });

    // Warm first, so it is the empty source and not the read that decides it.
    await identityPhone(CID);
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('drops a device cached for the previous character where nothing is counted', async () => {
    gate('');
    rowsOf({ [CID]: [device(CID, A_PHONE)] });
    await deviceForRequest(SRC, CID);
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);

    // The same character: no count to take, and the entry is still theirs.
    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'unavailable' });
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);

    // Another character on the same source: the old entry goes.
    bridgeMock.getPlayer.mockReturnValue({ ...player, citizenid: 'NEW00001' });
    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBeNull();
  });
});

/**
 * MICA-362: a request that is scoped by the device it claims to hold asks both questions of one
 * count, with the player the endpoint already looked up, and nothing is remembered between
 * requests — the count is the proof the phone is still in hand after a robbery.
 */
describe('the in-hand check and the resolve share one count (MICA-362)', () => {
  /** A player object other than the one `getPlayer` answers, so a second lookup is visible. */
  const handed = { citizenid: CID, source: SRC, setMeta: vi.fn(), rawPlayer: { handed: true } };

  beforeEach(() => {
    rowsOf({ [CID]: [device(CID, A_PHONE)] });
  });

  it('resolves with the player it was handed, one count, no lookup once the phone is known', async () => {
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toBe(A_PHONE);
    // The cold read yielded, so the source is asked once afterwards, before it is recorded.
    expect(bridgeMock.getPlayer.mock.calls).toEqual([[SRC]]);
    expect(bridgeMock.countItem.mock.calls).toEqual([[handed, 'phone']]);

    bridgeMock.getPlayer.mockClear();
    bridgeMock.countItem.mockClear();
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toBe(A_PHONE);
    expect(bridgeMock.getPlayer).not.toHaveBeenCalled();
    expect(bridgeMock.countItem.mock.calls).toEqual([[handed, 'phone']]);
  });

  it('still looks the player up when none is handed', async () => {
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    expect(bridgeMock.getPlayer).toHaveBeenCalledWith(SRC);
    expect(bridgeMock.countItem).toHaveBeenCalledWith(player, 'phone');
  });

  it('refuses a device this server has off before counting anything', async () => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_tablet' ? 'false' : name === 'mica_tablet_item' ? 'tablet' : fallback) as any;

    await expect(
      deviceForRequest(SRC, CID, 'tablet', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ key: 'server.device.off', params: { device: 'Tablet' } });

    expect(bridgeMock.countItem).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a request with no player to count for, rather than waving it through', async () => {
    gate('');
    bridgeMock.getPlayer.mockReturnValue(null);

    await expect(deviceForRequest(SRC, CID, 'phone', { requireHeld: true })).rejects.toMatchObject({
      key: 'server.phone.notHeld'
    });
    // The positive twin: without requireHeld, the citizen's phone, as it always was.
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
  });

  it('remembers nothing: a phone taken between two requests is refused on the second', async () => {
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toBe(A_PHONE);

    // Robbed: none in hand now.
    bridgeMock.countItem.mockReturnValue(0);
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ key: 'server.phone.notHeld' });

    expect(bridgeMock.countItem).toHaveBeenCalledTimes(2);
  });
});

/**
 * MICA-264: what `ServiceEndpoint` asks for every request naming a device other than the phone,
 * and every phone action flagged `requirePhoneFor`, against the real count. Synchronous again
 * since MICA-438.
 */
describe('the device a request claims to hold', () => {
  it('refuses a tablet this server has off, whatever the player holds', () => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_tablet' ? 'false' : name === 'mica_tablet_item' ? 'tablet' : fallback) as any;

    expect(() => requireDeviceInHand(player as any, 'tablet')).toThrow(
      expect.objectContaining({ key: 'server.device.off', params: { device: 'Tablet' } })
    );
  });

  it('refuses a count of none and passes any copy held', () => {
    gate('phone', 'tablet');
    bridgeMock.countItem.mockReturnValue(0);
    expect(() => requireDeviceInHand(player as any, 'tablet')).toThrow(
      expect.objectContaining({ key: 'server.device.notHeld', params: { device: 'Tablet' } })
    );
    expect(bridgeMock.countItem).toHaveBeenLastCalledWith(player, 'tablet');

    bridgeMock.countItem.mockReturnValue(1);
    expect(() => requireDeviceInHand(player as any, 'tablet')).not.toThrow();
  });

  it('passes a tablet with no item gate, without counting', () => {
    bridgeMock.countItem.mockReturnValue(0);
    expect(() => requireDeviceInHand(player as any, 'tablet')).not.toThrow();
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });

  it('holds a requirePhoneFor action to the count, and runs it for any copy held', async () => {
    __setDeviceResolvers({
      forRequest: deviceForRequest,
      forCitizen: phoneForCitizen,
      deviceInHand: requireDeviceInHand
    });
    const contract = defineContract({
      id: 'mica438_pay',
      actions: { send: { input: s.object({ amount: s.number({ min: 1, max: 10 }) }) } }
    });
    const app = new ServiceEndpoint<unknown, typeof contract>('mica438_pay', null, {
      contract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    const handler = vi.fn(async () => true);
    app.registerEvent('send', handler);
    app.requirePhoneFor('send');
    const send = handlers.get('mica:server:mica438_pay:send')!.at(-1)!;
    (globalThis as any).source = SRC;

    bridgeMock.countItem.mockReturnValue(0);
    await send('cb-1', { amount: 5 });
    expect(handler).not.toHaveBeenCalled();
    const replies = (globalThis.emitNet as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[3]
    );
    expect(replies).toContainEqual(expect.objectContaining({ key: 'server.phone.notHeld' }));

    // The positive twin: any phone item in hand, whoever bought it.
    bridgeMock.countItem.mockReturnValue(1);
    await send('cb-2', { amount: 5 });
    expect(handler).toHaveBeenCalledOnce();
    // Nothing was read to decide it: the count is the whole answer.
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

/**
 * MICA-264 review: the synchronous answer `LockState` keys on follows the device in hand. The
 * tablet is re-resolved on the occasions the phone is (a load or a relayed inventory change,
 * both `evaluateDeviceItems`), and a resolve that finds none clears the entry for either kind.
 */
describe('the device a source is on follows the item (MICA-264 review)', () => {
  beforeEach(() => {
    gate('phone', 'tablet');
    __resetLockState();
    rowsOf({ [CID]: [device(CID, A_PHONE), device(CID, A_TABLET, 'tablet', 2)] });
  });

  /** Let what a pass's subscribers started land. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('refreshes the tablet on a load or relayed change, with no device-owned request', async () => {
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(A_TABLET);
  });

  it('clears the tablet once it is put down, and the lock stays with the tablet', async () => {
    evaluateDeviceItems(SRC);
    await flush();
    setDeviceLocked(SRC, 'tablet', true);

    bridgeMock.countItem.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? 0 : 1
    );
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
    expect(isDeviceLocked(SRC, 'tablet')).toBe(false);

    // Any tablet item in hand again opens the same tablet, still locked.
    bridgeMock.countItem.mockReturnValue(1);
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(A_TABLET);
    expect(isDeviceLocked(SRC, 'tablet')).toBe(true);
  });

  it('clears the tablet when this server turns it off', async () => {
    evaluateDeviceItems(SRC);
    await flush();

    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_tablet' ? 'false' : name === 'mica_tablet_item' ? 'tablet' : fallback) as any;
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
  });

  it('creates nothing for a player who holds no tablet', async () => {
    rowsOf({});
    bridgeMock.countItem.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? 0 : 1
    );
    await resolveDevice(SRC, 'tablet');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

/**
 * MICA-440: on ESX a citizenid is the identifier, and esx_multicharacter hands a deleted
 * character's `char<slot>:<license>` to the next character created in the slot. The purge
 * erases the old phone; these drive the real character-deleted hook in `lib/shell.ts` and hold
 * this file's caches to it, so the new character, under the same citizenid, resolves to a phone
 * of their own in the same process rather than the one the cache still names.
 */
describe('a deleted character (MICA-440)', () => {
  const DELETED = 'mica:server:shell:characterDeleted';
  const B_PHONE = 'b'.repeat(32);

  /**
   * `mica_devices` as rows the identity read and the purge's erase both see: the erase moves the
   * named citizen's live rows to `erased`, and the read answers live rows only. Every other
   * statement the purge sends moves nothing.
   */
  const table = (...rows: ReturnType<typeof device>[]) => {
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.startsWith('UPDATE `mica_devices` SET `status` = ?')) {
        let moved = 0;
        for (const row of rows) {
          if (row.citizenid === params[1] && row.status === 'active') {
            row.status = 'erased';
            moved += 1;
          }
        }
        return { affectedRows: moved };
      }
      if (text.startsWith('SELECT') && text.includes('`mica_devices`')) {
        return rows.filter(
          (row) => row.citizenid === params[0] && row.kind === params[1] && row.status === 'active'
        );
      }
      return text.startsWith('UPDATE') ? { affectedRows: 0 } : [];
    });
    return rows;
  };

  /** Each statement on `mica_devices`, in order: an identity `read` or the purge's `erase`. */
  const deviceStatements = () =>
    dbMock.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('`mica_devices`'))
      .map((sql) => (sql.startsWith('UPDATE') ? 'erase' : 'read'));

  const purgeLogged = () =>
    vi.waitFor(() =>
      expect(
        logged.mock.calls.some((c) =>
          /erased \d+ row\(s\) for deleted character/.test(String(c[0]))
        )
      ).toBe(true)
    );

  let logged: MockInstance<typeof console.log>;
  beforeEach(() => {
    logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it('gives the next character under the identifier a new phone, read after the erase', async () => {
    const rows = table(device(CID, A_PHONE));
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(A_PHONE);
    expect(activePhoneIdOf(SRC)).toBe(A_PHONE);

    handlers.get(DELETED)![0](CID);
    // At once, so neither LockState nor the battery keys the old phone meanwhile.
    expect(activePhoneIdOf(SRC)).toBeNull();

    // The new character asks straight away, while the purge is still running.
    const fresh = await deviceForRequest(SRC, CID);

    expect(fresh).toMatch(ID_SHAPE);
    expect(fresh).not.toBe(A_PHONE);
    expect(rows[0].status).toBe('erased');
    expect(deviceInserts()).toEqual([
      { citizenid: CID, device_id: fresh, kind: 'phone', setup_pending: 1 }
    ]);
    // The ask waited for the erase: a read before it would have found the old phone again.
    expect(deviceStatements()).toEqual(['read', 'erase', 'read']);
    expect(activePhoneIdOf(SRC)).toBe(fresh);
    await purgeLogged();
  });

  it('caches nothing a read in flight at the delete found, and reads again after it', async () => {
    const rows = table(device(CID, A_PHONE));
    const live = dbMock.query.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The read is answered from the table as it is now, and lands only after the delete.
    dbMock.query.mockImplementationOnce(async (sql: string, params: unknown[]) => {
      const answer = await live(sql, params);
      await held;
      return answer;
    });

    const inFlight = identityPhone(CID);
    handlers.get(DELETED)![0](CID);
    release();

    // Its own caller gets what it read; nobody after it does.
    await expect(inFlight).resolves.toBe(A_PHONE);
    await purgeLogged();
    expect(rows[0].status).toBe('erased');
    const next = await identityPhone(CID);
    expect(next).toMatch(ID_SHAPE);
    expect(next).not.toBe(A_PHONE);
  });

  it("leaves another character's cached phone and source alone (the positive twin)", async () => {
    table(device(CID, A_PHONE), device(CID_B, B_PHONE));
    await deviceForRequest(SRC, CID);
    await deviceForRequest(SRC_B, CID_B);

    handlers.get(DELETED)![0](CID);
    await purgeLogged();

    expect(activePhoneIdOf(SRC)).toBeNull();
    expect(activePhoneIdOf(SRC_B)).toBe(B_PHONE);
    const reads = () => deviceStatements().filter((statement) => statement === 'read').length;
    const before = reads();
    await expect(deviceForRequest(SRC_B, CID_B)).resolves.toBe(B_PHONE);
    // Still cached: B's phone is answered without another read.
    expect(reads()).toBe(before);
  });
});

/**
 * MICA-440 review: a write on behalf of a character who does not exist — an export still naming
 * a deleted identifier — creates no phone for them. On ESX the next character created in the
 * slot would inherit it, and on qb it was a junk phone until the next sweep. Asked only on a
 * create, only for a citizen nobody vouched for and nobody has on a source, and never on
 * standalone or before a framework answers. A read that fails creates, and says so once.
 */
describe('no phone for a character who does not exist (MICA-440)', () => {
  const GONE = 'GONE0001';
  const OTHER = 'LATE0002';

  /** The owner-table reads a create made: the table it read, and whom it asked after. */
  const ownerReads = () =>
    dbMock.single.mock.calls
      .filter(([sql]) => String(sql).startsWith('SELECT 1 AS `found` FROM'))
      .map(([sql, params]) => [String(sql), params]);

  /**
   * A server the sweep would act on: a populated owner table on micaOS's collation, and one of
   * micaOS's own owners in it (`resolveOwner`). `holds` says who else it has. `matched: 0` is an
   * owner table that names none of micaOS's owners, which the sweep refuses.
   */
  const ownerTable = (holds: (citizenid: string) => boolean, { matched = 1 } = {}) => {
    const previous = dbMock.query.getMockImplementation();
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).startsWith('SELECT DISTINCT')
        ? [{ owner: CID }]
        : previous
          ? previous(sql, params)
          : []
    );
    dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes('AS total')) return { total: 3 };
      if (text.includes('AS collation')) {
        return { collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4' };
      }
      if (text.includes('AS matched')) return { matched };
      if (text.startsWith('SELECT 1 AS `found` FROM')) {
        return holds(String(params[0])) ? { found: 1 } : null;
      }
      return null;
    });
  };
  const nobody = () => false;

  let errors: MockInstance<typeof console.error>;
  beforeEach(() => {
    rowsOf({});
    __resetCreateVerdictForTests();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it('refuses the create, writes nothing, and reads the owner table by a bound id', async () => {
    ownerTable(nobody);

    await expect(phoneForCitizen(GONE)).rejects.toThrow(/no character .* exists here/);

    expect(deviceInserts()).toEqual([]);
    expect(ownerReads()).toEqual([
      ['SELECT 1 AS `found` FROM `players` WHERE `citizenid` = ? LIMIT 1', [GONE]]
    ]);
    // Refused, not failed: the line about a table it could not read is not said.
    expect(errors).not.toHaveBeenCalled();
  });

  it('creates for a character the owner table has, offline (the positive twin)', async () => {
    ownerTable((citizenid) => citizenid === GONE);

    const phone = await phoneForCitizen(GONE);

    expect(phone).toMatch(ID_SHAPE);
    expect(deviceInserts()).toEqual([
      { citizenid: GONE, device_id: phone, kind: 'phone', setup_pending: 1 }
    ]);
  });

  it('asks again after a refusal, so a character created later gets their phone', async () => {
    let created = false;
    ownerTable(() => created);
    await expect(identityPhone(GONE)).rejects.toThrow(/no character/);
    created = true;

    await expect(identityPhone(GONE)).resolves.toMatch(ID_SHAPE);
    expect(ownerReads()).toHaveLength(2);
  });

  it('asks nothing for a character the bridge has on a source', async () => {
    ownerTable(nobody);
    bridgeMock.getSourceByCitizenId.mockImplementation((citizenid: string) =>
      citizenid === GONE ? 42 : null
    );

    await expect(phoneForCitizen(GONE)).resolves.toMatch(ID_SHAPE);
    expect(ownerReads()).toEqual([]);
  });

  it('asks nothing for the player a request is from, whose row may not be written yet', async () => {
    ownerTable(nobody);
    const fresh = { citizenid: GONE, source: 9, setMeta: vi.fn(), rawPlayer: {} };
    bridgeMock.getPlayer.mockImplementation((src: number) => (src === 9 ? fresh : player));

    await expect(deviceForRequest(9, GONE)).resolves.toMatch(ID_SHAPE);
    expect(ownerReads()).toEqual([]);
  });

  it('asks nothing on standalone, or before a framework has answered', async () => {
    ownerTable(nobody);

    for (const kind of ['standalone', 'unknown']) {
      __resetDeviceState();
      framework.kind = kind;
      await expect(phoneForCitizen(GONE), kind).resolves.toMatch(ID_SHAPE);
    }
    expect(ownerReads()).toEqual([]);
  });

  it('creates when the owner table cannot be read, and says so once', async () => {
    dbMock.single.mockRejectedValue(new Error('connection lost'));

    await expect(phoneForCitizen(GONE)).resolves.toMatch(ID_SHAPE);
    await expect(phoneForCitizen(OTHER)).resolves.toMatch(ID_SHAPE);

    expect(deviceInserts()).toHaveLength(2);
    const said = errors.mock.calls.filter((c) =>
      /could not tell whether a character exists/.test(String(c[0]))
    );
    expect(said).toHaveLength(1);
  });

  /**
   * The in-server ESX run (2660b412): a fresh server owns no micaOS row before its first create,
   * whose verdict is `nothing-owned`. Kept the minute, it let a deleted character's create through
   * silently; never kept, the next create asks again and finds that first row to judge by.
   */
  it("asks again after a fresh server's first create, rather than letting creates through", async () => {
    let owned = false;
    ownerTable(nobody);
    const asked = dbMock.query.getMockImplementation()!;
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).startsWith('SELECT DISTINCT')
        ? owned
          ? [{ owner: CID }]
          : []
        : asked(sql, params)
    );

    // Nothing to judge: created, and nothing said.
    await expect(phoneForCitizen(OTHER)).resolves.toMatch(ID_SHAPE);
    owned = true;
    await expect(phoneForCitizen(GONE)).rejects.toThrow(/no character/);

    expect(ownerReads()).toEqual([
      ['SELECT 1 AS `found` FROM `players` WHERE `citizenid` = ? LIMIT 1', [GONE]]
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  /**
   * Kix's second round: an override that names a real column, but one holding none of micaOS's
   * owners, is a verdict the sweep refuses (`identity-mismatch`). Trusted here, it refused every
   * offline create for a phoneless character while the sweep refused itself at every start.
   */
  it('creates under an override the sweep would not act on, says so once, and reads no row', async () => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_orphan_owner_table'
        ? 'custom_characters.character_id'
        : name === 'mica_phone_item'
          ? 'phone'
          : fallback;
    // It verifies: the column is real.
    dbMock.scalar.mockImplementation(async (sql: string) =>
      String(sql) === 'SELECT DATABASE()' ? 'mica' : 1
    );
    ownerTable(nobody, { matched: 0 });
    try {
      await expect(phoneForCitizen(GONE)).resolves.toMatch(ID_SHAPE);
      await expect(phoneForCitizen(OTHER)).resolves.toMatch(ID_SHAPE);
    } finally {
      dbMock.scalar.mockReset();
    }

    expect(ownerReads()).toEqual([]);
    const said = errors.mock.calls.filter((c) =>
      /could not tell whether a character exists/.test(String(c[0]))
    );
    expect(said).toHaveLength(1);
    expect(String(said[0][1])).toMatch(/identity-mismatch/);
  });

  it('refuses the deleted character after the hook, where the cache had their phone', async () => {
    // The table answers live rows only, and the purge's erase moves A's to `erased`.
    const rows = [device(CID, A_PHONE)];
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.startsWith('UPDATE `mica_devices` SET `status` = ?')) {
        for (const row of rows) if (row.citizenid === params[1]) row.status = 'erased';
        return { affectedRows: 1 };
      }
      if (text.startsWith('SELECT') && text.includes('`mica_devices`')) {
        return rows.filter((row) => row.citizenid === params[0] && row.status === 'active');
      }
      return text.startsWith('UPDATE') ? { affectedRows: 0 } : [];
    });
    await expect(phoneForCitizen(CID)).resolves.toBe(A_PHONE);

    // Deleted at character select: not on a source, and gone from the owner table.
    bridgeMock.getSourceByCitizenId.mockReturnValue(null);
    ownerTable(nobody);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      handlers.get('mica:server:shell:characterDeleted')![0](CID);
      // An export still naming them, at once: it waits for the erase, then is refused.
      await expect(phoneForCitizen(CID)).rejects.toThrow(/no character/);
    } finally {
      logged.mockRestore();
    }
    expect(rows[0].status).toBe('erased');
    expect(deviceInserts()).toEqual([]);
  });
});
