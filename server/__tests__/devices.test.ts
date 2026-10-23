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
  phoneForCitizen,
  deviceForRequest,
  devices,
  requireDeviceInHand,
  requireDeviceInHandRead,
  resolvePhone,
  __resetDeviceState
} from '../services/Devices';
import {
  __resetLastUsedPhone,
  __resetPhoneItemWarnings,
  evaluateDeviceItems,
  lastUsedDeviceSlot
} from '../lib/deviceItem';
import { __setDeviceResolvers } from '../lib/deviceIdentity';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { defineContract } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import { __resetLockState, isDeviceLocked, setDeviceLocked } from '../lib/LockState';
import { __resetRateLimits } from '../lib/rateLimit';
import { who } from '../lib/who';
import { versionedWrites, type VersionedCall } from './versionedWrites';

/** The versioned writes this test made (MICA-430). */
let versionCalls: VersionedCall[] = [];

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

/** Let what a use or the look-again event left running land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `mica_phone_item` is what gates the whole feature; empty means no per-item identity. */
const gateOn = (item = 'phone') => {
  globalThis.GetConvar = ((name: string, fallback: string) =>
    name === 'mica_phone_item' ? item : fallback) as any;
};

beforeEach(() => {
  // MICA-430: a versioned write, through this suite's own stand-in.
  versionCalls = versionedWrites(dbMock);
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
    // The use reads whose phone slot 8 is before it records it (MICA-436).
    await flush();

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
    await flush();

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
    // Their own claimed phone: read, and nothing written (MICA-436 took the handover walk out).
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
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
    // Minted unclaimed — never written into an item — and only the once. The trailing `1` is
    // `setup_pending` (MICA-335): every row this server inserts owes its set-up until it runs.
    expect(dbMock.insert).toHaveBeenCalledOnce();
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, first, 'phone', 0, 1]);
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

  /**
   * MICA-436: a phone belongs to the citizen who first used it, for good. Somebody else holding
   * the item is refused every device-owned request, and nothing on the phone changes hands.
   */
  it('refuses a phone whose row names somebody else, and writes nothing', async () => {
    // Taken: the row names the owner, the item is in this player's hand.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: OTHER, device_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.phone.notHeld'
    });

    // No UPDATE at all — no walk, no claim, no version of the row — and nothing minted over it.
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(versionCalls).toEqual([]);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
    expect(activePhoneIdOf(SRC)).toBeNull();

    // Asked again, the answer is cached: no second read, still refused.
    await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({ key: 'server.phone.notHeld' });
    expect(dbMock.query).toHaveBeenCalledOnce();
  });

  it('still answers the owner after somebody else was refused it, untouched', async () => {
    const STOLEN = 'a'.repeat(32);
    const THIEF_SRC = 8;
    const thief = { citizenid: OTHER, source: THIEF_SRC, setMeta: vi.fn(), rawPlayer: {} };
    bridgeMock.getPlayer.mockImplementation((src: number) => (src === THIEF_SRC ? thief : player));
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: STOLEN } }]);
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, device_id: STOLEN, claimed: 1 }]);

    await expect(deviceForRequest(THIEF_SRC, OTHER)).rejects.toMatchObject({
      key: 'server.phone.notHeld'
    });
    // Back in the owner's hand: theirs, from the same cached read, with nothing written.
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(STOLEN);
    expect(dbMock.query).toHaveBeenCalledOnce();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('reads a phone once per process, and writes nothing for its owner', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, device_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await deviceForRequest(SRC, CID);
    await deviceForRequest(SRC, CID);

    // No walk on the first resolve any more (MICA-436), and the owner is cached after it.
    expect(dbMock.update).not.toHaveBeenCalled();
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
   * MICA-339 F7, under MICA-436: the victim resolved the phone before it was taken, so the
   * cache still names it. That is now right — the thief is refused the phone, nothing on it
   * moves, and what is filed there under the victim waits for them, as in a stash.
   */
  it("keeps filing a victim's rows on their phone while a thief holds it", async () => {
    const STOLEN = 'a'.repeat(32);
    const THIEF_SRC = 8;
    const THIEF = 'THIEF001';
    const thief = { citizenid: THIEF, source: THIEF_SRC, setMeta: vi.fn(), rawPlayer: {} };
    bridgeMock.getPlayer.mockImplementation((src: number) => (src === THIEF_SRC ? thief : player));
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: STOLEN } }]);
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, device_id: STOLEN, claimed: 1 }]);

    // The victim holds it: the cache answers, with no query.
    await deviceForRequest(SRC, CID);
    await expect(phoneForCitizen(CID)).resolves.toBe(STOLEN);
    expect(dbMock.single).not.toHaveBeenCalled();

    // The thief is refused it.
    await expect(deviceForRequest(THIEF_SRC, THIEF)).rejects.toMatchObject({
      key: 'server.phone.notHeld'
    });

    // The victim's next row still lands on their phone, for when they have it back.
    await expect(phoneForCitizen(CID)).resolves.toBe(STOLEN);
    // And the thief's own rows never land there: the phone they last used is their own.
    const THIEFS_OWN = 'b'.repeat(32);
    dbMock.single.mockResolvedValue({ device_id: THIEFS_OWN });
    await expect(phoneForCitizen(THIEF)).resolves.toBe(THIEFS_OWN);
    expect(dbMock.update).not.toHaveBeenCalled();
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

  const writesTo = (deviceId: string) =>
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
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, tablet, 'tablet', 1, 1]);
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
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, tablet, 'tablet', 1, 1]);
    // Nothing written to the phone: no claim, no version, nothing.
    expect(writesTo(PHONE_A)).toEqual([]);
    expect(activeDeviceIdOf(SRC, 'tablet')).toBe(tablet);
    // Said, by token: the operator's one sign of a tampered item (MICA-433 review).
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`item carried ${who(PHONE_A)}, which is a phone`);
    expect(line).not.toContain(PHONE_A);
    expect(line).not.toContain(CID);
    expect(line).not.toMatch(/slot/);
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
    expect(writesTo(TABLET_T)).toEqual([]);
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
      [CID, tablet, 'tablet', 0, 1],
      [CID, phone, 'phone', 0, 1]
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
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, phone, 'phone', 0, 1]);
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
    // An inventory that can count but not list slots: the count is all there is to ask.
    bridgeMock.itemSlots.mockReturnValue(null);

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

  it("refuses a player whose only tablet is somebody else's, once its row has been read", async () => {
    convars({ mica_tablet_item: 'tablet' });
    const THEIRS = 'd'.repeat(32);
    bridgeMock.itemSlots.mockImplementation((_p: unknown, item: string) =>
      item === 'tablet' ? [{ slot: 5, metadata: { deviceId: THEIRS } }] : []
    );
    dbMock.query.mockResolvedValue([
      { id: 2, citizenid: 'ZZZ99999', device_id: THEIRS, kind: 'tablet', claimed: 1 }
    ]);

    // Not read yet: synchronous, so "cannot say" is held rather than refused (MICA-436).
    expect(() => requireDeviceInHand(player as any, 'tablet')).not.toThrow();

    await expect(deviceForRequest(SRC, CID, 'tablet')).rejects.toMatchObject({
      key: 'server.device.notHeld'
    });
    expect(() => requireDeviceInHand(player as any, 'tablet')).toThrow(
      expect.objectContaining({ key: 'server.device.notHeld', params: { device: 'Tablet' } })
    );
    // Ruled by slot, not by count: the count would have passed it.
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });
});

/**
 * MICA-436: a phone belongs to the citizen who first used it, for good. The resolve skips a slot
 * carrying somebody else's phone, and the item gate counts by the same rule, so the shell stays
 * shut for a player holding nothing else. Both run for real here.
 */
describe("a phone is its first user's for good (MICA-436)", () => {
  const MINE = 'a'.repeat(32);
  const THEIRS = 'b'.repeat(32);
  const OTHER = 'ZZZ99999';
  const PUSH = 'mica:client:shell:phoneItem';

  /** Rows by phone id, and the caller's unclaimed phone, the way `findAll` would answer. */
  const rows = (byId: Record<string, object>, unclaimed?: object) => {
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
      for (const [id, row] of Object.entries(byId)) if (params.includes(id)) return [row];
      if (unclaimed && params.includes(0)) return [unclaimed];
      return [];
    });
  };
  const own = { id: 1, citizenid: CID, device_id: MINE, kind: 'phone', claimed: 1 };
  /** Updates whose parameters name this phone id. */
  const writesTo = (deviceId: string) =>
    dbMock.update.mock.calls.filter(([, params]) => (params as unknown[]).includes(deviceId));
  const theirs = { id: 2, citizenid: OTHER, device_id: THEIRS, kind: 'phone', claimed: 1 };

  const lookAgain = async () => {
    (globalThis as any).source = SRC;
    for (const handler of handlers.get('mica:server:shell:checkDeviceItem')!) handler();
    await flush();
  };

  beforeEach(() => {
    __resetRateLimits();
    // The count would say a phone is held, so a "not held" push can only come from the slots.
    bridgeMock.countItem.mockReturnValue(1);
  });

  it("resolves a holder of somebody else's phone and their own to their own", async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: THEIRS } },
      { slot: 5, metadata: { deviceId: MINE } }
    ]);
    rows({ [THEIRS]: theirs, [MINE]: own });

    await expect(resolvePhone(SRC)).resolves.toEqual({
      status: 'active',
      device: { deviceId: MINE, slot: 5 }
    });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("skips somebody else's phone even when it is the slot last used", async () => {
    rows({ [THEIRS]: theirs, [MINE]: own });
    // Their own phone, used from slot 8: slot 8 is the one last used.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 8, metadata: { deviceId: MINE } }]);
    usePhoneItem(SRC, { slot: 8 });
    await flush();
    expect(lastUsedDeviceSlot(SRC, 'phone')).toBe(8);

    // Swapped: slot 8 carries somebody else's phone now, and their own, MINE, sits in slot 2.
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: MINE } },
      { slot: 8, metadata: { deviceId: THEIRS } }
    ]);

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(MINE);
  });

  it("opens nothing for a use of somebody else's phone, and records no slot", async () => {
    rows({ [THEIRS]: theirs, [MINE]: own });
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: MINE } },
      { slot: 8, metadata: { deviceId: THEIRS } }
    ]);

    usePhoneItem(SRC, { slot: 8 });
    await flush();

    expect(globalThis.emitNet).not.toHaveBeenCalledWith('mica:client:shell:open', SRC);
    expect(lastUsedDeviceSlot(SRC, 'phone')).toBeUndefined();
  });

  /**
   * MICA-436 review: a phone with no row is nobody's yet. A create that fails refuses the
   * request rather than answering the phone, so nothing lands on it that the next resolve —
   * possibly somebody else's, if the item changes hands — would then own.
   */
  it('refuses a carried id whose row cannot be created, and creates it on the next resolve', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: MINE } }]);
    rows({});
    dbMock.insert.mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));

    await expect(deviceForRequest(SRC, CID)).rejects.toThrow(/could not record/);
    expect(activePhoneIdOf(SRC)).toBeNull();
    expect(dbMock.insert).toHaveBeenCalledOnce();

    // Nothing cached: the next resolve reads the row again and retries the create.
    const reads = dbMock.query.mock.calls.length;
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(MINE);
    expect(dbMock.query.mock.calls.length).toBeGreaterThan(reads);
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    expect(dbMock.insert.mock.calls[1][1]).toEqual([CID, MINE, 'phone', 1, 1]);
    expect(activePhoneIdOf(SRC)).toBe(MINE);
    error.mockRestore();
  });

  it('refuses a freshly minted id whose row cannot be created, and records it next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridgeMock.itemSlots.mockReturnValue([{ slot: 6, metadata: {} }]);
    rows({});
    dbMock.insert.mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));

    await expect(deviceForRequest(SRC, CID)).rejects.toThrow(/could not record/);
    const [written] = bridgeMock.setItemMetadata.mock.calls as unknown as [
      unknown,
      string,
      number,
      { deviceId: string }
    ][];
    const minted = written[3].deviceId;
    expect(minted).toMatch(ID_SHAPE);
    expect(activePhoneIdOf(SRC)).toBeNull();

    // The id is on the item: the next resolve reads it there and creates the row.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 6, metadata: { deviceId: minted } }]);
    await expect(deviceForRequest(SRC, CID)).resolves.toBe(minted);
    expect(dbMock.insert.mock.calls.at(-1)![1]).toEqual([CID, minted, 'phone', 1, 1]);
    error.mockRestore();
  });

  it('refuses an unclaimed row of their own whose claim fails, and claims it next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: MINE } }]);
    rows({ [MINE]: { ...own, id: 9, claimed: 0 } });
    dbMock.update.mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));

    await expect(deviceForRequest(SRC, CID)).rejects.toThrow(/could not record/);
    expect(activePhoneIdOf(SRC)).toBeNull();

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(MINE);
    const claims = dbMock.update.mock.calls.filter(([sql]) =>
      String(sql).includes('`claimed` = ?')
    );
    expect(claims).toHaveLength(2);
    error.mockRestore();
  });

  /**
   * MICA-436 review: an action that moves money or publishes (`requirePhoneFor`) is held to the
   * in-hand check on a service that never resolves its device. That check reads the row of a
   * slot this process has not seen, so somebody holding only another citizen's phone is refused
   * on the very first request, with nothing else having read that row.
   */
  it("refuses a requirePhoneFor action to a holder of only somebody else's phone, cold", async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 2, metadata: { deviceId: THEIRS } }]);
    rows({ [THEIRS]: theirs });
    __setDeviceResolvers({
      forRequest: deviceForRequest,
      forCitizen: phoneForCitizen,
      deviceInHand: requireDeviceInHand,
      deviceInHandRead: requireDeviceInHandRead
    });
    const contract = defineContract({
      id: 'mica436_pay',
      actions: { send: { input: s.object({ amount: s.number({ min: 1, max: 10 }) }) } }
    });
    const app = new ServiceEndpoint<unknown, typeof contract>('mica436_pay', null, {
      contract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    const handler = vi.fn(async () => true);
    app.registerEvent('send', handler);
    app.requirePhoneFor('send');

    (globalThis as any).source = SRC;
    await handlers.get('mica:server:mica436_pay:send')!.at(-1)!('cb-1', { amount: 5 });

    expect(handler).not.toHaveBeenCalled();
    const replies = (globalThis.emitNet as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[3]
    );
    expect(replies).toContainEqual(expect.objectContaining({ key: 'server.phone.notHeld' }));
    // The read was the endpoint's own: the row was not known before the request.
    expect(dbMock.query).toHaveBeenCalled();

    // The positive twin: the same player holding a phone of their own beside it is let through.
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: THEIRS } },
      { slot: 5, metadata: { deviceId: MINE } }
    ]);
    rows({ [THEIRS]: theirs, [MINE]: own });
    await handlers.get('mica:server:mica436_pay:send')!.at(-1)!('cb-2', { amount: 5 });
    expect(handler).toHaveBeenCalledOnce();
  });

  /**
   * MICA-436 review: that row read yields, and a character switch keeps the source. A request
   * whose source is another character by the time the read lands runs for neither.
   */
  it('runs no requirePhoneFor action when a character switch lands during the row read', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 5, metadata: { deviceId: MINE } }]);
    // Their own phone, not read yet: the check reads its row, and the switch lands meanwhile.
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
      if (!params.includes(MINE)) return [];
      bridgeMock.getPlayer.mockReturnValue({ ...player, citizenid: 'NEW00001' });
      return [own];
    });
    __setDeviceResolvers({
      forRequest: deviceForRequest,
      forCitizen: phoneForCitizen,
      deviceInHand: requireDeviceInHand,
      deviceInHandRead: requireDeviceInHandRead
    });
    const contract = defineContract({
      id: 'mica436_switch',
      actions: { send: { input: s.object({ amount: s.number({ min: 1, max: 10 }) }) } }
    });
    const app = new ServiceEndpoint<unknown, typeof contract>('mica436_switch', null, {
      contract,
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    const handler = vi.fn(async () => true);
    app.registerEvent('send', handler);
    app.requirePhoneFor('send');
    const send = handlers.get('mica:server:mica436_switch:send')!.at(-1)!;

    (globalThis as any).source = SRC;
    await send('cb-1', { amount: 5 });

    expect(dbMock.query).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    const replies = (globalThis.emitNet as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[3]
    );
    expect(replies).toContainEqual(expect.objectContaining({ key: 'server.generic' }));

    // The positive twin: the same character on the source, the same phone, now known — it runs.
    bridgeMock.getPlayer.mockReturnValue(player);
    await send('cb-2', { amount: 5 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resolves none for a holder of nothing but other people's phones, and pushes not held", async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: THEIRS } },
      { slot: 4, metadata: { deviceId: 'c'.repeat(32) } }
    ]);
    rows({
      [THEIRS]: theirs,
      ['c'.repeat(32)]: { id: 3, citizenid: 'YYY88888', device_id: 'c'.repeat(32), claimed: 1 }
    });

    await expect(resolvePhone(SRC)).resolves.toEqual({ status: 'none' });
    expect(activePhoneIdOf(SRC)).toBeNull();

    await lookAgain();
    expect(globalThis.emitNet).toHaveBeenCalledWith(PUSH, SRC, {
      device: 'phone',
      enabled: true,
      gated: true,
      held: false
    });
    expect(globalThis.emitNet).not.toHaveBeenCalledWith(
      PUSH,
      SRC,
      expect.objectContaining({
        device: 'phone',
        held: true
      })
    );
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('pushes not held from a cold start, reading the row it has not seen', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 2, metadata: { deviceId: THEIRS } }]);
    rows({ [THEIRS]: theirs });

    // No resolve first: the look-again pass reads the row itself before it pushes.
    await lookAgain();

    expect(globalThis.emitNet).toHaveBeenCalledWith(
      PUSH,
      SRC,
      expect.objectContaining({
        device: 'phone',
        held: false
      })
    );
    // And reads only: nothing claimed, minted or written.
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
  });

  it('pushes held to the same player once a phone of their own is in hand', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: THEIRS } },
      { slot: 5, metadata: { deviceId: MINE } }
    ]);
    rows({ [THEIRS]: theirs, [MINE]: own });

    await lookAgain();

    expect(globalThis.emitNet).toHaveBeenCalledWith(
      PUSH,
      SRC,
      expect.objectContaining({
        device: 'phone',
        held: true
      })
    );
  });

  it("still mints a blank phone beside somebody else's, as a burner", async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { deviceId: THEIRS } },
      { slot: 6, metadata: {} }
    ]);
    rows({ [THEIRS]: theirs });

    const active = await activePhone(SRC);

    expect(active?.slot).toBe(6);
    expect(active?.deviceId).toMatch(ID_SHAPE);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 6, {
      deviceId: active?.deviceId
    });
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, active?.deviceId, 'phone', 1, 1]);
    // Nothing written to the other phone.
    expect(writesTo(THEIRS)).toEqual([]);
  });

  it('refuses an unclaimed row carried on an item when it names somebody else', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: THEIRS } }]);
    rows({ [THEIRS]: { ...theirs, claimed: 0 } });

    await expect(deviceForRequest(SRC, CID)).rejects.toMatchObject({
      key: 'server.phone.notHeld'
    });
    // Not claimed for the holder: only the citizen it names may adopt it.
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('claims an unclaimed row carried on an item for the citizen it names', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: MINE } }]);
    rows({ [MINE]: { ...own, id: 9, claimed: 0 } });

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(MINE);
    const claim = dbMock.update.mock.calls.find(([sql]) => String(sql).includes('`claimed` = ?'));
    expect(claim, 'the phone is marked claimed').toBeDefined();
    expect(claim![1]).toEqual([1, 9, CID]);
  });
});

/**
 * MICA-362: a request that is scoped by the device it claims to hold asks both questions of one
 * slot read, with the player the endpoint already looked up, and nothing is remembered between
 * requests — the slot read is the proof the phone is still in hand after a robbery.
 */
describe('the in-hand check and the resolve share one slot read (MICA-362)', () => {
  const PHONE_A = 'a'.repeat(32);
  /** A player object other than the one `getPlayer` answers, so a second lookup is visible. */
  const handed = { citizenid: CID, source: SRC, setMeta: vi.fn(), rawPlayer: { handed: true } };
  const held = () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { deviceId: PHONE_A } }]);
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, device_id: PHONE_A, claimed: 1 }]);
  };

  it('resolves with the player it was handed, one slot read and no count', async () => {
    held();

    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toBe(PHONE_A);

    expect(bridgeMock.getPlayer).not.toHaveBeenCalled();
    expect(bridgeMock.itemSlots).toHaveBeenCalledOnce();
    expect(bridgeMock.itemSlots).toHaveBeenCalledWith(handed, 'phone');
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });

  it('still looks the player up when none is handed', async () => {
    held();

    await expect(deviceForRequest(SRC, CID)).resolves.toBe(PHONE_A);

    expect(bridgeMock.getPlayer).toHaveBeenCalledWith(SRC);
    expect(bridgeMock.itemSlots).toHaveBeenCalledWith(player, 'phone');
  });

  it('refuses a player holding none from the slot read alone', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);

    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ name: 'PlayerFacingError', key: 'server.phone.notHeld' });

    expect(bridgeMock.itemSlots).toHaveBeenCalledOnce();
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });

  it('refuses a device this server has off before reading anything', async () => {
    globalThis.GetConvar = ((name: string, fallback: string) =>
      name === 'mica_tablet' ? 'false' : name === 'mica_tablet_item' ? 'tablet' : fallback) as any;

    await expect(
      deviceForRequest(SRC, CID, 'tablet', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ key: 'server.device.off', params: { device: 'Tablet' } });

    expect(bridgeMock.itemSlots).not.toHaveBeenCalled();
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('counts where the inventory cannot list slots, and refuses a count of none', async () => {
    // es_extended's own inventory: no slots to list, but a count to ask.
    bridgeMock.itemSlots.mockReturnValue(null);
    bridgeMock.countItem.mockReturnValue(0);

    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ key: 'server.phone.notHeld' });

    expect(bridgeMock.countItem).toHaveBeenCalledOnce();
    expect(bridgeMock.countItem).toHaveBeenCalledWith(handed, 'phone');
  });

  it('answers the identity phone where the count says one is held', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    bridgeMock.countItem.mockReturnValue(1);

    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toMatch(ID_SHAPE);
  });

  it('never counts without requireHeld, degrading as it always has', async () => {
    // The positive twin of the refusal above: the same inventory, the same count of none,
    // answered rather than refused because nothing asked whether a phone is in hand.
    bridgeMock.itemSlots.mockReturnValue(null);
    bridgeMock.countItem.mockReturnValue(0);

    await expect(deviceForRequest(SRC, CID, 'phone', { player: handed as any })).resolves.toMatch(
      ID_SHAPE
    );

    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });

  it('does not count a phone the slot read already saw, when its id could not be written', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);
    bridgeMock.setItemMetadata.mockReturnValue(false);

    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toMatch(ID_SHAPE);

    expect(bridgeMock.countItem).not.toHaveBeenCalled();
  });

  it('remembers nothing: a phone taken between two requests is refused on the second', async () => {
    held();
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).resolves.toBe(PHONE_A);

    // Robbed: the slot is empty now.
    bridgeMock.itemSlots.mockReturnValue([]);
    await expect(
      deviceForRequest(SRC, CID, 'phone', { player: handed as any, requireHeld: true })
    ).rejects.toMatchObject({ key: 'server.phone.notHeld' });

    expect(bridgeMock.itemSlots).toHaveBeenCalledTimes(2);
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
