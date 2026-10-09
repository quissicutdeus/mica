// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock, handlers } = vi.hoisted(() => {
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
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1),
      // `lib/shell.ts` also listens for `playerDropped`, and this suite fires every listener.
      forgetSource: vi.fn(),
      rememberSource: vi.fn()
    },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qbx'
}));

import {
  activeDeviceIdOf,
  activePhone,
  activePhoneIdOf,
  identityPhone,
  onDeviceHandover,
  phoneForCitizen,
  deviceForRequest,
  devices,
  requireDeviceInHand,
  resolvePhone,
  __resetDeviceState
} from '../services/Devices';
import {
  __resetLastUsedPhone,
  __resetPhoneItemWarnings,
  evaluateDeviceItems
} from '../lib/deviceItem';
import { __resetLockState, isDeviceLocked, setDeviceLocked } from '../lib/LockState';

/**
 * `deviceItem.ts` registers its usable-item callback at import time, and `clearAllMocks`
 * wipes the call that recorded it — so it is taken here, once, while it is still there.
 */
const usePhoneItem: (src: number, used?: { slot?: unknown }) => void =
  bridgeMock.registerUsableItem.mock.calls.find((call: unknown[]) => call[0] === 'phone')?.[1];

/**
 * The phone as its own identity (MICA-280).
 *
 * The case that matters most is the one a truthiness check would miss: an inventory that
 * cannot carry metadata answers `null` from MICA-279's seam, and minting on that would hand a
 * player a brand new phone on every single resolve.
 */

const SRC = 7;
const CID = 'ABC12345';
const ID_SHAPE = /^[0-9a-f]{32}$/;

const player = { citizenid: CID, source: SRC, setMeta: vi.fn(), rawPlayer: {} };

/** `mica_phone_item` is what gates the whole feature; empty means no per-item identity. */
const gateOn = (item = 'phone') => {
  globalThis.GetConvar = ((name: string, fallback: string) =>
    name === 'mica_phone_item' ? item : fallback) as any;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetDeviceState();
  __resetLastUsedPhone();
  __resetPhoneItemWarnings();
  globalThis.emitNet = vi.fn() as any;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  bridgeMock.getPlayer.mockReturnValue(player);
  bridgeMock.setItemMetadata.mockReturnValue(true);
  gateOn();
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

  it('keeps device_id unique but lets one citizen hold several phones', () => {
    const unique = devices.resolved.indexes.filter((i) => i.unique).map((i) => i.name);
    expect(unique).toEqual(['device_id_unique']);
  });
});

describe('resolving the active phone', () => {
  it('mints an id into the item the first time and records a row', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);

    const active = await activePhone(SRC);

    expect(active?.slot).toBe(3);
    expect(active?.deviceId).toMatch(ID_SHAPE);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 3, {
      deviceId: active?.deviceId
    });
    expect(dbMock.insert).toHaveBeenCalledOnce();
  });

  it('reuses the id already on the item rather than minting a second', async () => {
    const carried = 'a'.repeat(32);
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: carried } }]);

    expect((await activePhone(SRC))?.deviceId).toBe(carried);
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
  });

  it('prefers the slot the player last used over the lowest one', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: 'b'.repeat(32) } },
      { slot: 8, metadata: { deviceId: 'c'.repeat(32) } }
    ]);

    // Driven through the real callback, the way qbx_core calls it: `fun(source, item)`.
    expect(usePhoneItem, 'the phone item registers a usable-item callback').toBeTypeOf('function');
    usePhoneItem(SRC, { slot: 8 });

    expect((await activePhone(SRC))?.slot).toBe(8);
  });

  it('falls back to the lowest slot when nothing has been used this session', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: 'b'.repeat(32) } },
      { slot: 8, metadata: { deviceId: 'c'.repeat(32) } }
    ]);

    expect((await activePhone(SRC))?.slot).toBe(2);
  });

  it('forgets the last-used slot on a disconnect, so a reused id inherits nothing', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: 'b'.repeat(32) } },
      { slot: 8, metadata: { deviceId: 'c'.repeat(32) } }
    ]);
    usePhoneItem(SRC, { slot: 8 });

    (globalThis as any).source = SRC;
    for (const dropped of handlers.get('playerDropped')!) dropped();

    expect((await activePhone(SRC))?.slot).toBe(2);
  });
});

describe('refusing to mint when it would be wrong', () => {
  it('mints nothing when the inventory cannot carry metadata at all', async () => {
    // `null` from the seam, not an empty list. Minting here would issue a fresh phone on every
    // resolve for a server that can never store one.
    bridgeMock.itemSlots.mockReturnValue(null);

    expect(await activePhone(SRC)).toBeNull();
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('mints nothing for a player holding no phone', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);
    expect(await activePhone(SRC)).toBeNull();
  });

  it('refuses when the metadata write did not take, rather than claiming an id', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);
    bridgeMock.setItemMetadata.mockReturnValue(false);

    expect(await activePhone(SRC)).toBeNull();
    // No row either: an id the item does not carry would be a different phone next relog.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('answers null when no phone item is configured at all', async () => {
    gateOn('');
    expect(await activePhone(SRC)).toBeNull();
    expect(bridgeMock.itemSlots).not.toHaveBeenCalled();
  });

  it('answers null for a source with no loaded character', async () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    expect(await activePhone(SRC)).toBeNull();
  });

  it('re-mints an id the item carries in a shape nothing here would have written', async () => {
    // Item metadata is another resource's storage and a modified inventory can put anything
    // there. Shape-checked before it reaches SQL; MICA-281 adds the predicate that makes a
    // well-formed but stolen id useless.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: "'; DROP TABLE--" } }]);

    const active = await activePhone(SRC);

    expect(active?.deviceId).toMatch(ID_SHAPE);
  });
});

/**
 * MICA-282: the phone a request is for, and what happens when a phone changes hands.
 *
 * Driven through `deviceForRequest` directly rather than the seam in `lib/deviceIdentity.ts`,
 * because `setup.ts` puts a stub in that seam before every test; the real resolver is what
 * is under test here.
 */
describe('the phone a request is for', () => {
  const OTHER = 'ZZZ99999';

  it('is the phone in hand on a gated server', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, device_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await expect(deviceForRequest(SRC, CID)).resolves.toBe('a'.repeat(32));
    // The only writes are the first resolve's handover walk (MICA-319), all to this holder.
    for (const [sql, params] of dbMock.update.mock.calls) {
      expect(String(sql)).toContain('WHERE `device_id` = ? AND `citizenid` <> ?');
      expect(params).toEqual([CID, 'a'.repeat(32), CID]);
    }
  });

  it('refuses a player holding no phone on a gated server, in words they can read', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);

    await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.phone.notHeld'
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('falls back to the identity phone where no phone id can be carried, minting it once', async () => {
    // `null` from the seam: this inventory cannot hold metadata. One phone per citizen, then.
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([]);

    const first = await deviceForRequest(SRC, CID);
    const second = await deviceForRequest(SRC, CID);

    expect(first).toMatch(ID_SHAPE);
    expect(second).toBe(first);
    // Minted unclaimed — never written into an item — and only the once.
    expect(dbMock.insert).toHaveBeenCalledOnce();
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, first, 'phone', 0]);
  });

  it('reuses an unclaimed phone the migration minted rather than minting a second', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([
      { id: 9, citizenid: CID, device_id: 'e'.repeat(32), claimed: 0 }
    ]);

    await expect(deviceForRequest(SRC, CID)).resolves.toBe('e'.repeat(32));
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('adopts the unclaimed phone into the first item with no id, and claims it', async () => {
    // The upgrade path: the migration's backfill is on the unclaimed phone, so the item in
    // hand takes that id instead of a fresh one, and the rows land where the player expects.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);
    dbMock.query.mockResolvedValue([
      { id: 9, citizenid: CID, device_id: 'e'.repeat(32), claimed: 0 }
    ]);

    await expect(deviceForRequest(SRC, CID)).resolves.toBe('e'.repeat(32));

    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 3, {
      deviceId: 'e'.repeat(32)
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
    const claim = dbMock.update.mock.calls.find(([sql]) => String(sql).includes('`claimed` = ?'));
    expect(claim, 'the phone is marked claimed').toBeDefined();
    expect(claim![1]).toEqual([1, 9, CID]);
  });

  it('hands a phone over to whoever is holding it, moving every phone-keyed table', async () => {
    // Steal a phone: the row names the previous holder, the item is in this player's hand.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: OTHER, device_id: 'a'.repeat(32), claimed: 1 }
    ]);
    const hook = vi.fn();
    onDeviceHandover('test-hook', hook);

    await expect(deviceForRequest(SRC, CID)).resolves.toBe('a'.repeat(32));

    const transfers = dbMock.update.mock.calls
      .map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' '), params }))
      .filter((c) => c.sql.includes('WHERE `device_id` = ? AND `citizenid` <> ?'));
    // Every repository that carries a device_id — this suite declares `devices` alone — and
    // the same three parameters for each: the new holder, the phone, and the new holder again.
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      expect(t.sql).toMatch(/^UPDATE `mica_\w+` SET `citizenid` = \?/);
      expect(t.params).toEqual([CID, 'a'.repeat(32), CID]);
    }
    expect(hook).toHaveBeenCalledWith('a'.repeat(32), CID);
  });

  it('re-checks a phone once per process when its holder is unchanged, and asks nothing twice', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, device_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await deviceForRequest(SRC, CID);
    // The first resolve since a start walks the phone even though its row names this holder
    // (MICA-319): a restart can leave some tables with whoever held it before.
    const walked = dbMock.update.mock.calls.length;
    expect(walked).toBeGreaterThan(0);

    await deviceForRequest(SRC, CID);

    // The holder is cached after the first resolve: no second read, no second walk.
    expect(dbMock.update).toHaveBeenCalledTimes(walked);
    expect(dbMock.query).toHaveBeenCalledOnce();
  });

  it("resolves a citizen's phone for a row written on their behalf", async () => {
    // Nothing resolved this process, no row in `mica_devices`: an identity phone is minted.
    dbMock.single.mockResolvedValue(null);
    dbMock.query.mockResolvedValue([]);

    const minted = await phoneForCitizen(CID);
    expect(minted).toMatch(ID_SHAPE);

    // With a phone on record, the most recently touched one wins and nothing is minted.
    dbMock.insert.mockClear();
    __resetDeviceState();
    dbMock.single.mockResolvedValue({ device_id: 'f'.repeat(32) });
    await expect(phoneForCitizen(CID)).resolves.toBe('f'.repeat(32));
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  /**
   * MICA-339 F7: the victim resolved the phone before it was taken, so the cache still named
   * it. A row filed there under the victim is hidden from them and handed to the thief by the
   * next handover walk.
   */
  it("never files a victim's row on the phone a thief now holds", async () => {
    const STOLEN = 'a'.repeat(32);
    const THIEF_SRC = 8;
    const THIEF = 'THIEF001';
    const thief = { citizenid: THIEF, source: THIEF_SRC, setMeta: vi.fn(), rawPlayer: {} };
    bridgeMock.getPlayer.mockImplementation((src: number) => (src === THIEF_SRC ? thief : player));
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: STOLEN } }]);

    // The victim holds it: the cache answers, with no query.
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, device_id: STOLEN, claimed: 1 }]);
    await deviceForRequest(SRC, CID);
    await expect(phoneForCitizen(CID)).resolves.toBe(STOLEN);
    expect(dbMock.single).not.toHaveBeenCalled();

    // The thief resolves it: a handover, and the row names the thief from here on.
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, device_id: STOLEN, claimed: 1 }]);
    await deviceForRequest(THIEF_SRC, THIEF);

    // The victim's next row lands on the phone they last touched that is still theirs.
    const KEPT = 'b'.repeat(32);
    dbMock.single.mockResolvedValue({ device_id: KEPT });
    await expect(phoneForCitizen(CID)).resolves.toBe(KEPT);
    // And the thief's own rows are on the phone in their hand.
    await expect(phoneForCitizen(THIEF)).resolves.toBe(STOLEN);
  });
});

describe('the phone a source is on, synchronously', () => {
  it('is unknown before the first resolve, known after it, and forgotten on a disconnect', async () => {
    expect(activePhoneIdOf(SRC)).toBeNull();

    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, device_id: 'a'.repeat(32), claimed: 1 }
    ]);
    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBe('a'.repeat(32));

    (globalThis as any).source = SRC;
    for (const dropped of handlers.get('playerDropped')!) dropped();
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('is the identity phone where no item can carry one', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([]);

    const identity = await deviceForRequest(SRC, CID);
    expect(activePhoneIdOf(SRC)).toBe(identity);
  });
});

/**
 * MICA-264: the tablet has an identity of its own — a `mica_devices` row of `kind = 'tablet'`,
 * minted into its own item — and none of a phone's reach.
 */
describe('the tablet as an identity of its own (MICA-264)', () => {
  const PHONE_A = 'a'.repeat(32);
  const TABLET_T = 'd'.repeat(32);
  const UNCLAIMED = 'e'.repeat(32);

  /** Both items gated, as a server with `mica_tablet_item` set has them. */
  const gateBoth = () => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_phone_item'
        ? 'phone'
        : name === 'mica_tablet_item'
          ? 'tablet'
          : fallback) as any;
  };

  /** Rows by phone id, and the citizen's unclaimed phone, the way `findAll` would answer. */
  const rows = (byId: Record<string, object>, unclaimed?: object) => {
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
      for (const [id, row] of Object.entries(byId)) if (params.includes(id)) return [row];
      if (unclaimed && params.includes('phone') && params.includes(0)) return [unclaimed];
      return [];
    });
  };

  const transfersOf = (deviceId: string) =>
    dbMock.update.mock.calls.filter(([, params]) => (params as unknown[]).includes(deviceId));

  beforeEach(() => {
    gateBoth();
  });

  it('mints a tablet its own id and kind, and never adopts the unclaimed phone', async () => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: {} }] : []
    );
    rows({}, { id: 9, citizenid: CID, device_id: UNCLAIMED, kind: 'phone', claimed: 0 });

    const tablet = await deviceForRequest(SRC, CID, 'tablet');

    expect(tablet).toMatch(ID_SHAPE);
    expect(tablet).not.toBe(UNCLAIMED);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'tablet', 5, {
      deviceId: tablet
    });
    expect(dbMock.insert).toHaveBeenCalledOnce();
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, tablet, 'tablet', 1]);
    // No look for an unclaimed row at all, and nothing claimed.
    expect(dbMock.query.mock.calls.some(([sql]) => String(sql).includes('`claimed`'))).toBe(false);
    expect(dbMock.update.mock.calls.some(([sql]) => String(sql).includes('`claimed` = ?'))).toBe(
      false
    );
  });

  it('refuses a phone id carried on a tablet item, and re-mints without touching the phone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: PHONE_A } }] : []
    );
    rows({
      [PHONE_A]: { id: 1, citizenid: 'ZZZ99999', device_id: PHONE_A, kind: 'phone', claimed: 1 }
    });

    const tablet = await deviceForRequest(SRC, CID, 'tablet');

    expect(tablet).toMatch(ID_SHAPE);
    expect(tablet).not.toBe(PHONE_A);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'tablet', 5, {
      deviceId: tablet
    });
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, tablet, 'tablet', 1]);
    // The phone's rows stay with its holder: no handover walk, no claim, nothing.
    expect(transfersOf(PHONE_A)).toEqual([]);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(tablet);
    expect(warn.mock.calls.some(([line]) => String(line).includes('which is a phone'))).toBe(true);
    warn.mockRestore();
  });

  it('refuses a phone id on a tablet item even once that phone is cached as held', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rows({ [PHONE_A]: { id: 1, citizenid: CID, device_id: PHONE_A, kind: 'phone', claimed: 1 } });
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'phone' ? [{ slot: 3, metadata: { deviceId: PHONE_A } }] : []
    );
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(PHONE_A);

    // The same id copied onto the tablet: the phone's holder is cached, so only the kind
    // cache stands between this and the phone's rows.
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet'
        ? [{ slot: 5, metadata: { deviceId: PHONE_A } }]
        : [{ slot: 3, metadata: { deviceId: PHONE_A } }]
    );
    const tablet = await deviceForRequest(SRC, CID, 'tablet');

    expect(tablet).not.toBe(PHONE_A);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(tablet);
    expect(activePhoneIdOf(SRC)).toBe(PHONE_A);
    warn.mockRestore();
  });

  it('refuses a tablet id carried on a phone item, the other way round', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'phone' ? [{ slot: 3, metadata: { deviceId: TABLET_T } }] : []
    );
    rows({
      [TABLET_T]: { id: 2, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 1 }
    });

    const phone = await deviceForRequest(SRC, CID);

    expect(phone).not.toBe(TABLET_T);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 3, {
      deviceId: phone
    });
    expect(transfersOf(TABLET_T)).toEqual([]);
    warn.mockRestore();
  });

  it('uses a tablet id carried on a tablet item, as the phone does its own', async () => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: TABLET_T } }] : []
    );
    rows({
      [TABLET_T]: { id: 2, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 1 }
    });

    await expect(deviceForRequest(SRC, CID, 'tablet')).resolves.toBe(TABLET_T);
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(TABLET_T);
    // The phone's synchronous answer is the phone's alone.
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('refuses the resolve rather than guess when the row cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: PHONE_A } }] : []
    );
    dbMock.query.mockRejectedValue(new Error('connection lost'));

    await expect(deviceForRequest(SRC, CID, 'tablet')).rejects.toThrow(/could not read/);
    // Neither used nor overwritten.
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
    error.mockRestore();
  });

  it('refuses a player holding no tablet on a gated server, in words they can read', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);

    await expect(deviceForRequest(SRC, CID, 'tablet')).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.device.notHeld',
      params: { device: 'Tablet' }
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('gives a tablet its own identity row where no item can carry one, apart from the phone', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([]);

    const tablet = await deviceForRequest(SRC, CID, 'tablet');
    const phone = await deviceForRequest(SRC, CID);

    expect(tablet).not.toBe(phone);
    expect(await deviceForRequest(SRC, CID, 'tablet')).toBe(tablet);
    const inserts = dbMock.insert.mock.calls.map(([, params]) => params);
    expect(inserts).toEqual([
      [CID, tablet, 'tablet', 0],
      [CID, phone, 'phone', 0]
    ]);
    // Each identity read asks for its own kind.
    const unclaimedReads = dbMock.query.mock.calls
      .filter(([sql]) => String(sql).includes('`claimed`'))
      .map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }));
    expect(unclaimedReads.map((read) => read.params.includes('tablet'))).toEqual([true, false]);
    expect(unclaimedReads.every((read) => read.sql.includes('`kind`'))).toBe(true);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(tablet);
    expect(activePhoneIdOf(SRC)).toBe(phone);
  });

  it("identityPhone never answers a citizen's tablet identity", async () => {
    // A tablet identity row on record, unclaimed: the phone's identity read filters it out.
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).includes('`kind`') && params.includes('tablet')
        ? [{ id: 4, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 0 }]
        : []
    );

    const phone = await identityPhone(CID);

    expect(phone).not.toBe(TABLET_T);
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, phone, 'phone', 0]);
  });

  it('phoneForCitizen reads phones only, and never the tablet the citizen used last', async () => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: TABLET_T } }] : []
    );
    rows({
      [TABLET_T]: { id: 2, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 1 }
    });
    await deviceForRequest(SRC, CID, 'tablet');
    dbMock.single.mockResolvedValue({ device_id: PHONE_A });

    await expect(phoneForCitizen(CID)).resolves.toBe(PHONE_A);
    const [sql, params] = dbMock.single.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain("`kind` = 'phone'");
    expect(params).toEqual([CID]);
  });

  it('a phone in hand is still what phoneForCitizen answers, beside a resolved tablet', async () => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet'
        ? [{ slot: 5, metadata: { deviceId: TABLET_T } }]
        : [{ slot: 3, metadata: { deviceId: PHONE_A } }]
    );
    rows({
      [TABLET_T]: { id: 2, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 1 },
      [PHONE_A]: { id: 1, citizenid: CID, device_id: PHONE_A, kind: 'phone', claimed: 1 }
    });
    await deviceForRequest(SRC, CID);
    await deviceForRequest(SRC, CID, 'tablet');

    await expect(phoneForCitizen(CID)).resolves.toBe(PHONE_A);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('forgets the tablet a source was on at a disconnect', async () => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: TABLET_T } }] : []
    );
    rows({
      [TABLET_T]: { id: 2, citizenid: CID, device_id: TABLET_T, kind: 'tablet', claimed: 1 }
    });
    await deviceForRequest(SRC, CID, 'tablet');
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(TABLET_T);

    (globalThis as any).source = SRC;
    for (const dropped of handlers.get('playerDropped')!) dropped();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
  });
});

/**
 * MICA-264: what `ServiceEndpoint` asks for every request naming a device other than the
 * phone, here against the real item count.
 */
describe('the device a request claims to hold (MICA-264)', () => {
  const convars = (values: Record<string, string>) => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name in values ? values[name] : fallback) as any;
  };

  it('refuses a tablet this server has off, whatever the player holds', () => {
    convars({ mica_tablet: 'false', mica_tablet_item: 'tablet' });
    bridgeMock.countItem.mockReturnValue(1);

    expect(() => requireDeviceInHand(player as any, 'tablet')).toThrow(
      expect.objectContaining({
        name: 'PlayerFacingError',
        key: 'server.device.off',
        params: { device: 'Tablet' }
      })
    );
  });

  it('refuses a player holding no tablet where one is required, and passes one who holds it', () => {
    convars({ mica_tablet_item: 'tablet' });

    bridgeMock.countItem.mockReturnValue(0);
    expect(() => requireDeviceInHand(player as any, 'tablet')).toThrow(
      expect.objectContaining({ key: 'server.device.notHeld', params: { device: 'Tablet' } })
    );
    expect(bridgeMock.countItem).toHaveBeenLastCalledWith(player, 'tablet');

    bridgeMock.countItem.mockReturnValue(1);
    expect(() => requireDeviceInHand(player as any, 'tablet')).not.toThrow();
  });

  it('passes a tablet with no item gate, which is on by default', () => {
    convars({});
    bridgeMock.countItem.mockReturnValue(0);

    expect(() => requireDeviceInHand(player as any, 'tablet')).not.toThrow();
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });
});

/**
 * MICA-264 review: the synchronous answer `LockState` keys on follows the device in hand. The
 * tablet is re-resolved on the occasions the phone is (a load or a relayed inventory change,
 * both `evaluateDeviceItems`), and a resolve that finds none clears the entry for either kind.
 */
describe('the device a source is on follows the item (MICA-264 review)', () => {
  const TABLET_T = 'd'.repeat(32);
  const TABLET_U = '9'.repeat(32);
  const PHONE_A = 'a'.repeat(32);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const gateBoth = () => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_phone_item'
        ? 'phone'
        : name === 'mica_tablet_item'
          ? 'tablet'
          : fallback) as any;
  };

  /** What each item holds now; every id answers as its own kind, held by whoever asks. */
  const holding = (tablet: unknown[] | null, phone: unknown[] | null = []) => {
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? tablet : phone
    );
  };

  beforeEach(() => {
    gateBoth();
    __resetLockState();
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
      for (const [id, kind] of [
        [TABLET_T, 'tablet'],
        [TABLET_U, 'tablet'],
        [PHONE_A, 'phone']
      ] as const) {
        if (params.includes(id))
          return [{ id: 1, citizenid: CID, device_id: id, kind, claimed: 1 }];
      }
      return [];
    });
  });

  it('clears the phone when a resolve finds none, so the gap MICA-283 left is closed', async () => {
    holding([], [{ slot: 3, metadata: { deviceId: PHONE_A } }]);
    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBe(PHONE_A);

    holding([], []);
    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'none' });
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('refreshes the tablet on a load or relayed change, with no device-owned request', async () => {
    holding([{ slot: 5, metadata: { deviceId: TABLET_T } }]);
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(TABLET_T);

    // Switched tablets: the next pass follows, and so does the lock key.
    setDeviceLocked(SRC, 'tablet', true);
    holding([{ slot: 6, metadata: { deviceId: TABLET_U } }]);
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(TABLET_U);
    expect(isDeviceLocked(SRC, 'tablet')).toBe(false);
  });

  it('clears the tablet once it is handed over, so LockPhone keys the source, not its id', async () => {
    holding([{ slot: 5, metadata: { deviceId: TABLET_T } }]);
    evaluateDeviceItems(SRC);
    await flush();
    setDeviceLocked(SRC, 'tablet', true);

    holding([]);
    evaluateDeviceItems(SRC);
    await flush();

    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
    expect(isDeviceLocked(SRC, 'tablet')).toBe(false);
    // The tablet's own lock stayed with the tablet, for whoever holds it next.
    holding([{ slot: 5, metadata: { deviceId: TABLET_T } }]);
    evaluateDeviceItems(SRC);
    await flush();
    expect(isDeviceLocked(SRC, 'tablet')).toBe(true);
  });

  it('clears the tablet when this server turns it off', async () => {
    holding([{ slot: 5, metadata: { deviceId: TABLET_T } }]);
    evaluateDeviceItems(SRC);
    await flush();

    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_tablet' ? 'false' : name === 'mica_tablet_item' ? 'tablet' : fallback) as any;
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
  });

  it('drops a device cached for the previous character where no item can carry an id', async () => {
    // No inventory metadata: the identity tablet is what a request resolves to.
    holding(null, null);
    dbMock.query.mockResolvedValue([]);
    const identity = await deviceForRequest(SRC, CID, 'tablet');
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(identity);

    // The same character again: the identity entry is still theirs, and stays.
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(identity);

    // A character switch on the same source: the load re-resolves and the old entry goes.
    bridgeMock.getPlayer.mockReturnValue({ ...player, citizenid: 'NEW00001' });
    evaluateDeviceItems(SRC);
    await flush();
    expect(activeDeviceIdOf(SRC, 'tablet')).toBeNull();
  });

  it('mints nothing for a player who holds no tablet', async () => {
    holding([]);
    evaluateDeviceItems(SRC);
    await flush();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
  });
});
