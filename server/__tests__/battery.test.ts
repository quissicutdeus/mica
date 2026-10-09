// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, bridgeMock, handlers, everyHandler } = vi.hoisted(() => {
  // Inside `vi.hoisted` because ESM evaluates imports first: assigning `on`/`onNet`
  // below the imports would run after the service registered and capture nothing.
  const captured = new Map<string, Function>();
  // Every handler per event as well (MICA-337): `playerDropped` has one per module, and which
  // one `captured` keeps depends on import order.
  const all = new Map<string, Function[]>();
  const captureHandler = (event: string, handler: Function) => {
    captured.set(event, handler);
    all.set(event, [...(all.get(event) ?? []), handler]);
  };
  (globalThis as any).on = captureHandler;
  (globalThis as any).onNet = captureHandler;

  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    // registerUsableItem runs at import time; the rest is only what this suite drives.
    // `forgetSource` is `lib/shell.ts`'s `playerDropped`, which the MICA-337 cases run too.
    bridgeMock: { getPlayer: vi.fn(), registerUsableItem: vi.fn(), forgetSource: vi.fn() },
    handlers: captured,
    everyHandler: all
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));
/**
 * `services/Phones.ts`'s synchronous identity cache, which is all Battery reads from it: which
 * tablet a source is using, if any (MICA-337). Nothing is in use unless a case says so.
 */
const inUse = vi.hoisted(() => ({ tablet: null as string | null }));
vi.mock('../services/Phones', () => ({
  activeDeviceIdOf: (_src: number, kind: string) => (kind === 'tablet' ? inUse.tablet : null)
}));
/**
 * The device-state subscribers (MICA-264) are run fire-and-forget by `deviceItem.ts`, with no
 * seam to await one. Wrapped here so a case can run Battery's tablet subscriber and wait on it,
 * while the real registration still happens underneath.
 */
const deviceStateSubscribers = vi.hoisted(
  () => new Map<string, (src: number, device: 'phone' | 'tablet') => unknown>()
);
vi.mock('../lib/deviceItem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/deviceItem')>();
  return {
    ...actual,
    onDeviceStateChanged: (
      name: string,
      run: (src: number, device: 'phone' | 'tablet') => unknown
    ) => {
      deviceStateSubscribers.set(name, run);
      actual.onDeviceStateChanged(name, run);
    }
  };
});

import {
  applyCharge,
  batteryApp,
  batteryItemCharge,
  batteryItemName,
  currentCharge,
  runChargeCommand,
  savePlayerBattery,
  sendLoadedBatteryToClient,
  setCharging,
  __resetBatteryCache,
  __resetBatteryItemWarnings,
  __resetBatteryState,
  __tickBattery
} from '../services/Battery';

/**
 * The usable-item registration runs at import time, and `beforeEach`'s `clearAllMocks` wipes
 * the record of it — so the callback is taken here, once, while the call is still there.
 * Matched by item name rather than by position, because `deviceItem.ts` registers through the
 * same mock when `mica_phone_item` is set.
 */
const batteryItemHandler: (src: number) => void = bridgeMock.registerUsableItem.mock.calls.find(
  (call: unknown[]) => call[0] === 'battery_bank'
)?.[1];
import { __resetRateLimits } from '../lib/rateLimit';
import { __setPhoneResolvers } from '../lib/phoneIdentity';
import { TEST_PHONE_ID } from './phoneStub';
import { PlayerFacingError } from '../lib/errors';

const SRC = 7;
const CID = 'ABC12345';

const mockPlayer = (metadata: Record<string, unknown> = {}) => ({
  citizenid: CID,
  source: SRC,
  setMeta: vi.fn(),
  rawPlayer: { PlayerData: { metadata } }
});

/** The last `emitNet('mica:client:battery:set', ...)` level, or undefined. */
const emittedCharge = (): number | undefined => {
  const call = (globalThis.emitNet as any).mock.calls
    .filter((c: any[]) => c[0] === 'mica:client:battery:set')
    .pop();
  return call?.[2];
};

beforeEach(() => {
  // The shared setup installs a plain noop; this suite needs to read the calls.
  globalThis.emitNet = vi.fn() as any;
  vi.clearAllMocks();
  // MICA-136 put the player-loaded path behind the rate limiter, so this suite now
  // consumes a window it never used to. Reset it rather than depending on this file running
  // before whichever other suite shares the limiter's module state — an unstated ordering
  // dependency fails later, for a reason unrelated to the assertion that reports it.
  __resetRateLimits();
  __resetBatteryCache();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
});

describe('battery table declaration', () => {
  it('is server-authored, so no column is client-writable', () => {
    expect(batteryApp.repo.writableColumns).toEqual([]);
  });

  it('carries a unique index on the phone, so a phone cannot end up with two rows', () => {
    // Per phone since MICA-283: two phones hold two charges, so the key names the device.
    const unique = batteryApp.resolved.indexes.filter((i) => i.unique);
    expect(unique).toEqual([{ name: 'phone_id_unique', columns: ['phone_id'], unique: true }]);
  });
});

describe('savePlayerBattery', () => {
  it('inserts a row when the player has none', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledOnce();
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(sql).toContain('INSERT INTO `mica_battery`');
    expect(params).toEqual(expect.arrayContaining([CID, 42]));
  });

  it('updates the existing row rather than inserting a second', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockResolvedValue([{ id: 3, citizenid: CID, level: 90 }]);

    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).not.toHaveBeenCalled();
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(sql).toContain('UPDATE `mica_battery`');
    // Ownership-scoped: the citizenid is in the WHERE clause, not just the lookup — and the
    // phone beside it (MICA-283).
    expect(sql).toContain('AND `citizenid` = ?');
    expect(sql).toContain('AND `phone_id` = ?');
    expect(params).toEqual([42, 3, CID, TEST_PHONE_ID]);
  });

  it('skips the write when the whole percent has not moved', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await savePlayerBattery(SRC, 42.4);
    await savePlayerBattery(SRC, 42.1);

    // The drain loop reports every 15s but moves 0.25%; four of five reports are noise.
    expect(dbMock.insert).toHaveBeenCalledOnce();
  });

  it('writes again once the percent actually changes', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await savePlayerBattery(SRC, 42);
    await savePlayerBattery(SRC, 41);

    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it('clamps out-of-range levels', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await savePlayerBattery(SRC, 250);
    expect(dbMock.insert.mock.calls[0][1]).toEqual(expect.arrayContaining([100]));

    await savePlayerBattery(SRC, -80);
    expect(dbMock.insert.mock.calls[1][1]).toEqual(expect.arrayContaining([0]));
  });

  it('does nothing for a source with no loaded character', async () => {
    bridgeMock.getPlayer.mockReturnValue(null);

    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('retries after a failed write instead of caching the level it never stored', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.insert.mockRejectedValueOnce(new Error('deadlock'));

    await savePlayerBattery(SRC, 42);
    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });
});

describe('sendLoadedBatteryToClient', () => {
  it('sends the stored level', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockResolvedValue([{ id: 3, citizenid: CID, level: 37 }]);

    await sendLoadedBatteryToClient(SRC);

    expect(emittedCharge()).toBe(37);
  });

  it('falls back to framework metadata on the first load, then adopts it', async () => {
    // Players who had a charge before this table existed must not be reset to 100%.
    const player = mockPlayer({ mica_battery: 55 });
    bridgeMock.getPlayer.mockReturnValue(player);
    dbMock.query.mockResolvedValue([]);

    await sendLoadedBatteryToClient(SRC);

    expect(emittedCharge()).toBe(55);
    expect(dbMock.insert.mock.calls[0][1]).toEqual(expect.arrayContaining([CID, 55]));
  });

  it('reads the legacy phone_battery key too', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer({ phone_battery: 12 }));

    await sendLoadedBatteryToClient(SRC);

    expect(emittedCharge()).toBe(12);
  });

  it('defaults to full with no row and no metadata', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await sendLoadedBatteryToClient(SRC);

    expect(emittedCharge()).toBe(100);
  });

  it('sends full without touching the database for an unloaded character', async () => {
    // A multichar player still at the selection screen has no citizenid. Keying a row to
    // `src_<id>` would attach it to a source number the next player inherits.
    bridgeMock.getPlayer.mockReturnValue(null);

    await sendLoadedBatteryToClient(SRC);

    expect(emittedCharge()).toBe(100);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

/**
 * MICA-326: a failed read was treated as "no saved row", so the charge defaulted to the
 * legacy metadata or 100 and the adoption save wrote it — one transient error, and a saved
 * 12% came back as a full battery. The phone still has a value with nothing pushed: the
 * client starts at 100 on its own, and that number is display, not a write.
 */
describe('a load that cannot read the table (MICA-326)', () => {
  const PHONE_A = 'a'.repeat(32);
  const PHONE_B = 'b'.repeat(32);
  const SAVED = [{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 12 }];
  const phoneStateChanged = async (src: number) => {
    const { __phoneStateSubscribers } = await import('../lib/deviceItem');
    for (const subscriber of __phoneStateSubscribers()) {
      if (subscriber.name === 'battery') await subscriber.run(src);
    }
  };
  /** `applyCharge` and the tick save fire-and-forget; let them reach the mock. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const writes = () => dbMock.insert.mock.calls.length + dbMock.update.mock.calls.length;

  beforeEach(() => {
    __resetBatteryState();
    (globalThis as any).emitNet = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __setPhoneResolvers({ forRequest: async () => PHONE_A });
  });

  it('writes nothing, even with legacy metadata to adopt, and holds no charge', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer({ mica_battery: 55 }));
    dbMock.query.mockRejectedValue(new Error('connection lost'));

    await sendLoadedBatteryToClient(SRC);
    __tickBattery();
    await settle();

    expect(writes()).toBe(0);
    expect(chargeCalls()).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('retries on the next phone-state event, and loads the saved charge rather than writing', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);

    dbMock.query.mockResolvedValue(SAVED);
    await phoneStateChanged(SRC);

    expect(currentCharge(SRC)).toBe(12);
    expect(emittedCharge()).toBe(12);
    expect(writes()).toBe(0);
  });

  it('retries once: a phone-state event after a good load reads nothing more', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockResolvedValue(SAVED);
    await phoneStateChanged(SRC);
    dbMock.query.mockClear();

    await phoneStateChanged(SRC);

    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('keeps the last charge known for the same phone on a failed reload', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockResolvedValue(SAVED);
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockRejectedValue(new Error('connection lost'));
    (globalThis as any).emitNet = vi.fn();

    await sendLoadedBatteryToClient(SRC);
    await settle();

    expect(currentCharge(SRC)).toBe(12);
    expect(emittedCharge()).toBe(12);
    expect(writes()).toBe(0);
  });

  it('does not tick the old phone charge into a new phone it could not read', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    let phone = PHONE_A;
    __setPhoneResolvers({ forRequest: async () => phone });
    dbMock.query.mockResolvedValue(SAVED);
    await sendLoadedBatteryToClient(SRC);

    // Only the new phone's load fails; every read after it works, so a save that went
    // ahead would reach the database rather than failing on its own read.
    phone = PHONE_B;
    let readsOfB = 0;
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === PHONE_A) return SAVED;
      readsOfB += 1;
      if (readsOfB === 1) throw new Error('connection lost');
      return [];
    });
    await phoneStateChanged(SRC);
    // One short of the minute-long retry (12 ticks), which would legitimately read B's empty
    // table and adopt; eleven ticks are enough to move a held 100 or 12 a whole percent.
    for (let i = 0; i < 11; i += 1) __tickBattery();
    await settle();

    const toB = [...dbMock.insert.mock.calls, ...dbMock.update.mock.calls].filter(([, params]) =>
      (params as unknown[]).includes(PHONE_B)
    );
    expect(toB).toEqual([]);
  });

  it('saves no guessed 100 over the previous phone when the player stops holding one', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    let holding = true;
    __setPhoneResolvers({
      forRequest: async () => {
        if (holding) return PHONE_A;
        throw new PlayerFacingError('You are not holding a phone.', {
          key: 'server.phone.notHeld'
        });
      }
    });
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockResolvedValue(SAVED);

    holding = false;
    await phoneStateChanged(SRC);
    await settle();

    expect(writes()).toBe(0);
  });

  it('lets an explicit set win over the failed load, so no retry repaints the stale row', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockResolvedValue(SAVED);

    applyCharge(SRC, 90);
    await settle();
    await phoneStateChanged(SRC);

    expect(currentCharge(SRC)).toBe(90);
  });

  it('rejects the export read rather than answering a full battery', async () => {
    __setPhoneResolvers({ forCitizen: async () => PHONE_A });
    dbMock.query.mockRejectedValue(new Error('connection lost'));
    const { getBatteryLevel } = await import('../services/Battery');

    await expect(getBatteryLevel(CID)).rejects.toThrow('connection lost');
  });

  /** A read that answers when the test says so, to hold a load in flight. */
  const heldRead = () => {
    let release: (rows: unknown[]) => void = () => {};
    const pending = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    return { pending, release: (rows: unknown[]) => release(rows) };
  };
  /** The minute-long retry interval, in ticks (`LOAD_RETRY_TICKS`). */
  const RETRY_TICKS = 12;

  it('refuses the battery bank while no charge is held, and keeps the item', async () => {
    // Thire, MICA-326 review: `currentCharge` answers 100 for nothing held, so the bank wrote
    // 100 over a saved 12%, and `applyCharge` cleared the mark so nothing corrected it.
    globalThis.GetConvarInt = ((_n: string, fallback: number) => fallback) as any;
    const player = { ...mockPlayer(), removeItem: vi.fn().mockReturnValue(true) };
    bridgeMock.getPlayer.mockReturnValue(player);
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockResolvedValue(SAVED);

    batteryItemHandler(SRC);
    await settle();

    expect(player.removeItem).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    // Told, rather than an item that silently does nothing.
    expect(notifies().map((call: any[]) => call[2]?.key)).toEqual(['server.battery.unavailable']);
  });

  it('retries from the tick about once a minute, where no phone-state event comes', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockClear();
    dbMock.query.mockResolvedValue(SAVED);

    for (let i = 0; i < RETRY_TICKS - 1; i += 1) __tickBattery();
    await settle();
    expect(dbMock.query).not.toHaveBeenCalled();

    __tickBattery();
    await settle();

    expect(dbMock.query).toHaveBeenCalledOnce();
    expect(currentCharge(SRC)).toBe(12);
    expect(emittedCharge()).toBe(12);
    expect(writes()).toBe(0);
  });

  it('keeps one retry in flight per source, however many ticks and events pass', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    const read = heldRead();
    dbMock.query.mockClear();
    dbMock.query.mockReturnValue(read.pending);

    for (let i = 0; i < RETRY_TICKS * 3; i += 1) __tickBattery();
    void phoneStateChanged(SRC);
    await settle();

    expect(dbMock.query).toHaveBeenCalledOnce();
    read.release(SAVED);
    await settle();
    expect(currentCharge(SRC)).toBe(12);
  });

  it('stops retrying once the player leaves', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockClear();
    dbMock.query.mockResolvedValue(SAVED);

    (globalThis as any).source = SRC;
    handlers.get('playerDropped')!();
    for (let i = 0; i < RETRY_TICKS * 2; i += 1) __tickBattery();
    await settle();

    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('saves no guessed 100 over the previous phone when switching to a different one', async () => {
    // The `held` guard on the switch: Thire removed it and every case stayed green.
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    let phone = PHONE_A;
    __setPhoneResolvers({ forRequest: async () => phone });
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    // Every read works from here, so a save of A would reach the database.
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === PHONE_A ? SAVED : []
    );

    phone = PHONE_B;
    await phoneStateChanged(SRC);
    await settle();

    const toA = [...dbMock.insert.mock.calls, ...dbMock.update.mock.calls].filter(([, params]) =>
      (params as unknown[]).includes(PHONE_A)
    );
    expect(toA).toEqual([]);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("ticks no old-phone charge into the new phone's row while that row is being read", async () => {
    // Thire's re-check, reproduced: A's 12 stayed live during B's read, a tick crossing a
    // whole percent saved 11 into B's row (80) through the moved `phoneOf`, and B's read then
    // failing left B at 11 for good.
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    let phone = PHONE_A;
    __setPhoneResolvers({ forRequest: async () => phone });
    dbMock.query.mockResolvedValue(SAVED);
    await sendLoadedBatteryToClient(SRC);

    const firstReadOfB = heldRead();
    let readsOfB = 0;
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === PHONE_A) return SAVED;
      readsOfB += 1;
      if (readsOfB === 1) return firstReadOfB.pending;
      // Every later read of B answers its row, so a save into B would reach `update`.
      return [{ id: 2, citizenid: CID, phone_id: PHONE_B, level: 80 }];
    });
    phone = PHONE_B;
    const switching = phoneStateChanged(SRC);
    await settle();
    dbMock.update.mockClear();
    dbMock.insert.mockClear();

    for (let i = 0; i < RETRY_TICKS - 1; i += 1) __tickBattery();
    await settle();
    firstReadOfB.release(Promise.reject(new Error('connection lost')) as never);
    await switching.catch(() => {});
    await settle();

    const toB = [...dbMock.insert.mock.calls, ...dbMock.update.mock.calls].filter(([, params]) =>
      (params as unknown[]).includes(PHONE_B)
    );
    expect(toB).toEqual([]);
  });

  it('discards a retry read that a set overtook, so the stale row is not painted back', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await sendLoadedBatteryToClient(SRC);
    const read = heldRead();
    dbMock.query.mockReturnValueOnce(read.pending);
    dbMock.query.mockResolvedValue(SAVED);

    const retry = phoneStateChanged(SRC);
    await settle();
    applyCharge(SRC, 90);
    read.release(SAVED);
    await retry;
    await settle();

    expect(currentCharge(SRC)).toBe(90);
    expect(emittedCharge()).toBe(90);
  });

  it('discards a first load that a set overtook, too', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    const read = heldRead();
    dbMock.query.mockReturnValueOnce(read.pending);
    dbMock.query.mockResolvedValue(SAVED);

    const load = sendLoadedBatteryToClient(SRC);
    await settle();
    applyCharge(SRC, 90);
    read.release(SAVED);
    await load;
    await settle();

    expect(currentCharge(SRC)).toBe(90);
  });
});

/**
 * A multichar switch loads a second character on a source that never disconnected. Nothing
 * else forgets the source, and `phoneOf` answers without asking, so the new character used to
 * load — and, with a failed read, keep — the previous character's phone and charge.
 */
describe('a character switch on the same source', () => {
  const PHONE_A = 'a'.repeat(32);
  const PHONE_B = 'b'.repeat(32);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    __resetBatteryState();
    __resetRateLimits();
    (globalThis as any).emitNet = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('loads the new character on their own phone, not the previous character', async () => {
    let character = { cid: CID, phone: PHONE_A };
    bridgeMock.getPlayer.mockImplementation(() => ({ ...mockPlayer(), citizenid: character.cid }));
    __setPhoneResolvers({ forRequest: async () => character.phone });
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === PHONE_A
        ? [{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 30 }]
        : [{ id: 2, citizenid: 'OTHER001', phone_id: PHONE_B, level: 70 }]
    );
    await sendLoadedBatteryToClient(SRC);
    expect(currentCharge(SRC)).toBe(30);

    character = { cid: 'OTHER001', phone: PHONE_B };
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: SRC } });
    await settle();
    await settle();

    expect(currentCharge(SRC)).toBe(70);
    expect(emittedCharge()).toBe(70);
  });

  it('holds no previous-character charge when the new character cannot be read', async () => {
    let character = { cid: CID, phone: PHONE_A };
    bridgeMock.getPlayer.mockImplementation(() => ({ ...mockPlayer(), citizenid: character.cid }));
    __setPhoneResolvers({ forRequest: async () => character.phone });
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 30 }]);
    await sendLoadedBatteryToClient(SRC);

    character = { cid: 'OTHER001', phone: PHONE_B };
    dbMock.query.mockRejectedValue(new Error('connection lost'));
    (globalThis as any).emitNet = vi.fn();
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: SRC } });
    await settle();
    await settle();

    // A kept charge is pushed as "the last one known for this phone"; the previous
    // character's 30 is not this character's to show, tick or save. Asserted on the push
    // rather than on a write, because a save here would fail on its own rejected read.
    expect(chargeCalls()).toEqual([]);
    expect(dbMock.query.mock.calls.some(([, params]) => (params as unknown[])[0] === PHONE_B)).toBe(
      true
    );
  });
});

const notifies = () =>
  (globalThis.emitNet as any).mock.calls.filter((c: any[]) => c[0] === 'mica:client:shell:notify');
const chargeCalls = () =>
  (globalThis.emitNet as any).mock.calls.filter((c: any[]) => c[0] === 'mica:client:battery:set');

describe('micacharge command', () => {
  beforeEach(() => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
    (globalThis as any).IsPlayerAceAllowed = () => false;
  });

  it('accepts a server admin holding `command` but not mica.admin', async () => {
    // The command ran its own `mica.admin` check rather than going through isAdmin,
    // so it refused the very admins the rest of the resource accepts — and said
    // nothing, because at the time the denial notify had no client listener.
    (globalThis as any).IsPlayerAceAllowed = (_s: string, ace: string) => ace === 'command';

    runChargeCommand(SRC, ['100']);
    await Promise.resolve();

    expect(chargeCalls()[0]?.[2]).toBe(100);
  });

  it('refuses a player with no admin ace, and says so', () => {
    runChargeCommand(SRC, ['100']);

    expect(chargeCalls()).toHaveLength(0);
    expect(notifies()[0]?.[2]).toMatchObject({ type: 'error' });
  });

  it('defaults a player to their own phone', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;

    runChargeCommand(SRC, ['42']);
    await Promise.resolve();

    expect(chargeCalls()[0]?.[1]).toBe(SRC);
    expect(chargeCalls()[0]?.[2]).toBe(42);
  });

  it('lets the console target another player without any ace', async () => {
    runChargeCommand(0, ['12', '80']);
    await Promise.resolve();

    expect(chargeCalls()[0]?.[1]).toBe(12);
    expect(chargeCalls()[0]?.[2]).toBe(80);
  });

  it('rejects the console omitting a target', () => {
    runChargeCommand(0, ['80']);
    expect(chargeCalls()).toHaveLength(0);
  });

  it('clamps rather than trusting the argument', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;

    runChargeCommand(SRC, ['9999']);
    await Promise.resolve();

    expect(chargeCalls()[0]?.[2]).toBe(100);
  });

  it('reports usage to the player, not only the console', () => {
    // Typing it wrong in chat previously produced a console.log the player cannot see,
    // so the command simply looked broken.
    (globalThis as any).IsPlayerAceAllowed = () => true;

    runChargeCommand(SRC, []);

    expect(chargeCalls()).toHaveLength(0);
    expect(notifies()[0]?.[2]?.message).toMatch(/usage/i);
  });
});

describe('character-loaded listeners', () => {
  it('registers for both QBCore and qbx player-loaded events', () => {
    expect(handlers.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
    expect(handlers.has('QBCore:Server:PlayerLoaded')).toBe(true);
  });

  it('loads the connection when qbx_core sends no payload', () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    (globalThis as any).source = SRC;
    handlers.get('QBCore:Server:OnPlayerLoaded')!(undefined);
    expect(bridgeMock.getPlayer).toHaveBeenCalledWith(SRC);
  });

  it('loads the resolved source from a QBCore player object', () => {
    // The local twin, which no client can emit — it keeps reading the payload.
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: SRC } });
    expect(bridgeMock.getPlayer).toHaveBeenCalledWith(SRC);
  });

  it('ignores a network payload naming a third party', () => {
    // MICA-136. This is the widest of the three: acting on a named id read that
    // player's row, could write it, and overwrote their live server-side charge.
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    (globalThis as any).source = SRC;
    handlers.get('QBCore:Server:OnPlayerLoaded')!({ PlayerData: { source: 99 } });
    expect(bridgeMock.getPlayer).not.toHaveBeenCalledWith(99);
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });

  it('does nothing when the local twin cannot resolve a source', () => {
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: {} });
    expect(bridgeMock.getPlayer).not.toHaveBeenCalled();
  });
});

describe('a disconnect', () => {
  /** `playerDropped` carries no argument; the handler reads the global `source`. */
  const dropSource = (src: number) => {
    (globalThis as any).source = src;
    const handler = handlers.get('playerDropped');
    if (!handler) throw new Error('no handler for playerDropped');
    handler();
  };

  /** A minute of ticks — 12 x 5s, which is exactly 1% of drain or 10% of charge. */
  const tickAMinute = () => {
    for (let i = 0; i < 12; i += 1) __tickBattery();
  };

  beforeEach(() => {
    __resetBatteryState();
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockResolvedValue([{ id: 3, citizenid: CID, level: 50 }]);
  });

  it('unplugs the charger, so the next player on that id is not charging', async () => {
    setCharging(SRC, true);
    dropSource(SRC);

    // The same source, a different person: FiveM hands server ids straight back out.
    await sendLoadedBatteryToClient(SRC);
    tickAMinute();

    // Draining, not charging. With the flag left set this reads 60.
    expect(currentCharge(SRC)).toBe(49);
  });

  it('stops ticking the source at all', async () => {
    await sendLoadedBatteryToClient(SRC);
    dropSource(SRC);
    (globalThis.emitNet as any).mockClear();

    tickAMinute();

    // No entry left to iterate: nothing is pushed, and the map answers the absent default.
    expect(chargeCalls()).toHaveLength(0);
    expect(currentCharge(SRC)).toBe(100);
  });

  it('forgets the write-skip entry, so the same level is written again on a rejoin', async () => {
    dbMock.query.mockResolvedValue([]);

    await savePlayerBattery(SRC, 42);
    expect(dbMock.insert).toHaveBeenCalledOnce();

    dropSource(SRC);
    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });
});

describe('the write-skip cache', () => {
  const playerFor = (citizenid: string) => ({
    citizenid,
    source: SRC,
    setMeta: vi.fn(),
    rawPlayer: { PlayerData: { metadata: {} } }
  });

  it('is bounded, so a server that has seen thousands of characters does not hold them all', async () => {
    // Mirrors WRITE_CACHE_LIMIT in Battery.ts. If that number moves, this fails loudly
    // rather than quietly stopping being a test of the bound.
    const limit = 512;
    __resetBatteryState();
    // The cache is keyed by phone since MICA-283, so every character here is on a phone of
    // their own, and each report comes from its own source — one source is one character.
    __setPhoneResolvers({ forRequest: async (_src, citizenid) => `phone-of-${citizenid}` });
    bridgeMock.getPlayer.mockReturnValue(playerFor(CID));

    await savePlayerBattery(SRC, 42);
    expect(dbMock.insert).toHaveBeenCalledOnce();

    for (let i = 0; i < limit; i += 1) {
      bridgeMock.getPlayer.mockReturnValue(playerFor(`CID_${i}`));
      await savePlayerBattery(SRC + 1 + i, 42);
    }

    // The first phone has aged out, so its next report is a write rather than a skip.
    bridgeMock.getPlayer.mockReturnValue(playerFor(CID));
    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledTimes(limit + 2);
  });
});

/**
 * The battery bank (MICA-257).
 *
 * None of this was covered: the item plumbing had tests in `FrameworkBridge.test.ts` and the
 * handler behind it had none, which is how both use paths came to skip `applyCharge` and get
 * silently reverted by the very next drain tick.
 */
describe('the battery bank item', () => {
  const playerHolding = (removed: boolean) => ({
    ...mockPlayer(),
    removeItem: vi.fn().mockReturnValue(removed)
  });

  /** Seed the live charge without needing `getPlayer` to answer, which this case removes. */
  const charge40WithoutAPlayer = () => {
    bridgeMock.getPlayer.mockReturnValueOnce(mockPlayer());
    applyCharge(SRC, 40);
    bridgeMock.getPlayer.mockReturnValue(undefined);
  };

  beforeEach(() => {
    __resetBatteryState();
    __resetBatteryItemWarnings();
    globalThis.GetConvar = ((_n: string, fallback: string) => fallback) as any;
    globalThis.GetConvarInt = ((_n: string, fallback: number) => fallback) as any;
  });

  it('is registered under the name the convar gives, so an owner can rename it', () => {
    expect(batteryItemHandler).toBeTypeOf('function');
  });

  it('spends the item and applies the charge, so the next tick cannot revert it', async () => {
    const player = playerHolding(true);
    bridgeMock.getPlayer.mockReturnValue(player);
    applyCharge(SRC, 40);

    batteryItemHandler(SRC);

    expect(player.removeItem).toHaveBeenCalledWith('battery_bank', 1);
    // The map, not just the wire. A push alone is what the drain loop used to paint over.
    expect(currentCharge(SRC)).toBe(100);
    expect(emittedCharge()).toBe(100);
  });

  it('adds only the percent the convar asks for', () => {
    bridgeMock.getPlayer.mockReturnValue(playerHolding(true));
    globalThis.GetConvarInt = ((_n: string, _f: number) => 25) as any;
    applyCharge(SRC, 40);

    batteryItemHandler(SRC);

    expect(currentCharge(SRC)).toBe(65);
  });

  it('clamps rather than overflowing a phone that is nearly full', () => {
    bridgeMock.getPlayer.mockReturnValue(playerHolding(true));
    applyCharge(SRC, 80);

    batteryItemHandler(SRC);

    expect(currentCharge(SRC)).toBe(100);
  });

  it('changes nothing when the item was not really in the inventory', () => {
    const player = playerHolding(false);
    bridgeMock.getPlayer.mockReturnValue(player);
    applyCharge(SRC, 40);
    (globalThis.emitNet as any).mockClear();

    batteryItemHandler(SRC);

    expect(currentCharge(SRC)).toBe(40);
    expect(emittedCharge()).toBeUndefined();
  });

  it('hands out nothing when there is no player to take the item from', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    charge40WithoutAPlayer();
    (globalThis.emitNet as any).mockClear();

    batteryItemHandler(SRC);

    // Fails closed. This answered "removed" for an unloaded source and gave the charge away.
    expect(currentCharge(SRC)).toBe(40);
    expect(emittedCharge()).toBeUndefined();
  });
});

describe('the battery item convars', () => {
  beforeEach(() => {
    __resetBatteryItemWarnings();
    globalThis.GetConvar = ((_n: string, fallback: string) => fallback) as any;
    globalThis.GetConvarInt = ((_n: string, fallback: number) => fallback) as any;
  });

  it('defaults to battery_bank at a full charge', () => {
    expect(batteryItemName()).toBe('battery_bank');
    expect(batteryItemCharge()).toBe(100);
  });

  it('takes the name an owner sets', () => {
    globalThis.GetConvar = ((_n: string, _f: string) => 'powerbank') as any;
    expect(batteryItemName()).toBe('powerbank');
  });

  it('turns the item off entirely when the convar is emptied', () => {
    globalThis.GetConvar = ((_n: string, _f: string) => '  ') as any;
    expect(batteryItemName()).toBeNull();
  });

  it('refuses a name no inventory would accept, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.GetConvar = ((_n: string, _f: string) => 'battery bank; DROP TABLE') as any;

    expect(batteryItemName()).toBeNull();
    expect(batteryItemName()).toBeNull();

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('clamps a charge outside 1-100 rather than trusting the typo', () => {
    globalThis.GetConvarInt = ((_n: string, _f: number) => 900) as any;
    expect(batteryItemCharge()).toBe(100);

    globalThis.GetConvarInt = ((_n: string, _f: number) => 0) as any;
    expect(batteryItemCharge()).toBe(1);
  });
});

/**
 * MICA-283: the charge belongs to the phone in hand. Two phones hold two charges, the live
 * charge follows a switch, and a battery bank charges the one being used.
 */
describe('the charge follows the phone', () => {
  const PHONE_A = 'a'.repeat(32);
  const PHONE_B = 'b'.repeat(32);
  /** The phone-state subscriber Battery registered at import, run for one source. */
  const phoneStateChanged = async (src: number) => {
    const { __phoneStateSubscribers } = await import('../lib/deviceItem');
    for (const subscriber of __phoneStateSubscribers()) {
      if (subscriber.name === 'battery') await subscriber.run(src);
    }
  };

  beforeEach(() => {
    __resetBatteryState();
    __resetRateLimits();
    (globalThis as any).emitNet = vi.fn();
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
  });

  it('loads and saves the charge of the phone in hand, not the character', async () => {
    __setPhoneResolvers({ forRequest: async () => PHONE_A });
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 30 }]);

    await sendLoadedBatteryToClient(SRC);

    expect(dbMock.query.mock.calls[0][1]).toEqual([PHONE_A, 'active']);
    expect(currentCharge(SRC)).toBe(30);
  });

  it('switching phones saves the old charge and loads the new one', async () => {
    let phone = PHONE_A;
    __setPhoneResolvers({ forRequest: async () => phone });
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === PHONE_A
        ? [{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 30 }]
        : [{ id: 2, citizenid: CID, phone_id: PHONE_B, level: 80 }]
    );
    await sendLoadedBatteryToClient(SRC);
    applyCharge(SRC, 25);
    dbMock.update.mockClear();

    phone = PHONE_B;
    await phoneStateChanged(SRC);

    // The old phone got the charge it had; the live value is now the new phone's.
    const saves = dbMock.update.mock.calls.map(([, params]) => params as unknown[]);
    expect(saves.some((p) => p[0] === 25 && p.includes(PHONE_A))).toBe(true);
    expect(currentCharge(SRC)).toBe(80);
    expect((globalThis.emitNet as any).mock.calls.at(-1)).toEqual([
      'mica:client:battery:set',
      SRC,
      80
    ]);
  });

  it('does nothing on a phone-state event that did not change the phone', async () => {
    __setPhoneResolvers({ forRequest: async () => PHONE_A });
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, phone_id: PHONE_A, level: 30 }]);
    await sendLoadedBatteryToClient(SRC);
    dbMock.query.mockClear();
    dbMock.update.mockClear();

    await phoneStateChanged(SRC);

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(currentCharge(SRC)).toBe(30);
  });

  it('holds nothing live for a player holding no phone on a gated server', async () => {
    __setPhoneResolvers({
      forRequest: async () => {
        throw new PlayerFacingError('You are not holding a phone.', {
          key: 'server.phone.notHeld'
        });
      }
    });

    await sendLoadedBatteryToClient(SRC);
    await savePlayerBattery(SRC, 50);

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(currentCharge(SRC)).toBe(100);
  });

  it('answers the export for the phone the character is on', async () => {
    __setPhoneResolvers({ forCitizen: async () => PHONE_B });
    dbMock.query.mockResolvedValue([{ id: 2, citizenid: CID, phone_id: PHONE_B, level: 63 }]);
    const { getBatteryLevel } = await import('../services/Battery');

    await expect(getBatteryLevel(CID)).resolves.toBe(63);
    expect(dbMock.query.mock.calls[0][1]).toEqual([PHONE_B, 'active']);
  });
});

/**
 * MICA-337: the tablet has a battery of its own. Every case here holds a phone and a tablet at
 * once, on ids of their own, and checks that what happens to one never reaches the other.
 */
describe('the tablet has a battery of its own (MICA-337)', () => {
  const PHONE_A = 'a'.repeat(32);
  const TABLET_A = 'c'.repeat(32);
  const TABLET_B = 'd'.repeat(32);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const tickAMinute = () => {
    for (let i = 0; i < 12; i += 1) __tickBattery();
  };

  /**
   * What each device resolves to; `null` is "holding none", which a gated server refuses. What
   * `services/Phones.ts` has cached as in use is `inUse`, moved by a case where Phones would.
   */
  const hand: { phone: string | null; tablet: string | null } = {
    phone: PHONE_A,
    tablet: TABLET_A
  };
  const tabletConvar = { on: true };
  const LEVELS: Record<string, number> = { [PHONE_A]: 30, [TABLET_A]: 80, [TABLET_B]: 55 };

  const tabletPushes = () => chargeCalls().filter((c: any[]) => c[3] === 'tablet');
  const phonePushes = () => chargeCalls().filter((c: any[]) => c[3] === undefined);
  const queriedIds = () => dbMock.query.mock.calls.map(([, params]) => (params as unknown[])[0]);
  const updates = () => dbMock.update.mock.calls.map(([, params]) => params as unknown[]);

  /** The tablet subscriber Battery registered with `onDeviceStateChanged`, awaited. */
  const tabletStateChanged = async (src: number) => {
    const run = deviceStateSubscribers.get('battery');
    if (!run) throw new Error('battery registered no device-state subscriber');
    await run(src, 'tablet');
  };

  const setOpen = (src: number, device: 'phone' | 'tablet', open: boolean) => {
    (globalThis as any).source = src;
    handlers.get('mica:server:shell:setOpen')!({ device, open });
  };

  const dropSource = (src: number) => {
    (globalThis as any).source = src;
    for (const handler of everyHandler.get('playerDropped') ?? []) handler();
  };

  beforeEach(async () => {
    __resetBatteryState();
    __resetRateLimits();
    const { __resetOpenState } = await import('../lib/PhoneOpenState');
    __resetOpenState();
    (globalThis as any).emitNet = vi.fn();
    hand.phone = PHONE_A;
    hand.tablet = TABLET_A;
    inUse.tablet = TABLET_A;
    tabletConvar.on = true;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_tablet' ? (tabletConvar.on ? 'true' : 'false') : fallback;
    (globalThis as any).GetConvarInt = (_n: string, fallback: number) => fallback;
    bridgeMock.getPlayer.mockReturnValue({ ...mockPlayer(), removeItem: vi.fn(() => true) });
    __setPhoneResolvers({
      forRequest: async (_src, _citizenid, device = 'phone') => {
        const id = hand[device];
        if (id === null) {
          throw new PlayerFacingError(`You are not holding a ${device}.`, {
            key: 'server.device.notHeld'
          });
        }
        return id;
      }
    });
    dbMock.query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const id = params[0] as string;
      return id in LEVELS
        ? [{ id: id.charCodeAt(0), citizenid: CID, phone_id: id, level: LEVELS[id] }]
        : [];
    });
  });

  afterEach(() => {
    inUse.tablet = null;
  });

  describe('battery:load', () => {
    const load = async () => {
      (globalThis as any).source = SRC;
      handlers.get('mica:server:battery:load')!();
      await settle();
      await settle();
    };

    it('answers for the phone and the tablet, each from its own row', async () => {
      await load();

      expect(phonePushes()).toEqual([['mica:client:battery:set', SRC, 30]]);
      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 80, 'tablet']]);
      expect(currentCharge(SRC)).toBe(30);
      expect(currentCharge(SRC, 'tablet')).toBe(80);
    });

    it('answers for the phone alone while mica_tablet is off, and never reads a tablet', async () => {
      tabletConvar.on = false;
      await load();

      expect(phonePushes()).toHaveLength(1);
      expect(tabletPushes()).toHaveLength(0);
      expect(queriedIds()).not.toContain(TABLET_A);
    });

    it('still answers the phone when the tablet is not held, and holds no tablet charge', async () => {
      hand.tablet = null;
      inUse.tablet = null;
      await load();

      expect(phonePushes()).toHaveLength(1);
      expect(tabletPushes()).toHaveLength(0);
      tickAMinute();
      expect(tabletPushes()).toHaveLength(0);
    });

    it('pushes the phone its default and holds no tablet for a source with no character', async () => {
      // Pinned by the endpoints harness too: an unnameable source gets defaults and no data.
      bridgeMock.getPlayer.mockReturnValue(undefined);
      // Direct, as the connect path reaches it: `battery:load` is guarded and drops a source
      // with no character before it gets here.
      await sendLoadedBatteryToClient(SRC);
      await sendLoadedBatteryToClient(SRC, 'tablet');

      expect(phonePushes()).toEqual([['mica:client:battery:set', SRC, 100]]);
      expect(tabletPushes()).toHaveLength(0);
      (globalThis as any).emitNet = vi.fn();
      tickAMinute();
      expect(tabletPushes()).toHaveLength(0);
    });
  });

  describe('loading lazily: a tablet nobody has used is never minted or drained', () => {
    const tabletResolves = () => resolverCalls.filter(([, , device]) => device === 'tablet').length;
    const resolverCalls: unknown[][] = [];

    beforeEach(() => {
      resolverCalls.length = 0;
      inUse.tablet = null;
      __setPhoneResolvers({
        forRequest: async (src, citizenid, device = 'phone') => {
          resolverCalls.push([src, citizenid, device]);
          const id = hand[device];
          if (id === null) throw new PlayerFacingError('none', { key: 'server.device.notHeld' });
          return id;
        }
      });
    });

    const characterLoads = async () => {
      handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: SRC } });
      await settle();
      await settle();
    };

    it('a character load loads the phone only, and never resolves a tablet', async () => {
      await characterLoads();
      tickAMinute();
      await settle();

      expect(currentCharge(SRC)).toBeLessThan(31);
      expect(tabletResolves()).toBe(0);
      expect(queriedIds()).not.toContain(TABLET_A);
      expect(tabletPushes()).toHaveLength(0);
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('battery:load answers no tablet before one is in use, and resolves none', async () => {
      (globalThis as any).source = SRC;
      handlers.get('mica:server:battery:load')!();
      await settle();
      await settle();

      expect(phonePushes()).toHaveLength(1);
      expect(tabletPushes()).toHaveLength(0);
      expect(tabletResolves()).toBe(0);
    });

    it('the tick loads a tablet once its own use has given it an identity', async () => {
      await characterLoads();
      __tickBattery();
      await settle();
      expect(tabletPushes()).toHaveLength(0);

      inUse.tablet = TABLET_A;
      __tickBattery();
      await settle();
      await settle();

      expect(currentCharge(SRC, 'tablet')).toBe(80);
      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 80, 'tablet']]);
      // Loaded from the identity Phones holds, not by resolving (and so minting) one.
      expect(tabletResolves()).toBe(0);
    });

    it('battery:load answers a tablet charge already held without reading it again', async () => {
      inUse.tablet = TABLET_A;
      await sendLoadedBatteryToClient(SRC, 'tablet');
      applyCharge(SRC, 64, 'tablet');
      await settle();
      dbMock.query.mockClear();
      (globalThis as any).emitNet = vi.fn();

      (globalThis as any).source = SRC;
      handlers.get('mica:server:battery:load')!();
      await settle();
      await settle();

      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 64, 'tablet']]);
      expect(queriedIds()).not.toContain(TABLET_A);
    });

    it('the read export neither resolves nor reads a tablet that has no identity', async () => {
      const { getBatteryLevel } = await import('../services/Battery');

      await expect(getBatteryLevel(CID, 'tablet', SRC)).resolves.toBeNull();
      expect(tabletResolves()).toBe(0);
      expect(dbMock.query).not.toHaveBeenCalled();
    });

    it('SetCharging refuses a tablet with no identity, and flags nothing', () => {
      expect(setCharging(SRC, true, 'tablet')).toBe(false);
      expect(globalThis.emitNet).not.toHaveBeenCalled();
      inUse.tablet = TABLET_A;
      expect(setCharging(SRC, true, 'tablet')).toBe(true);
    });
  });

  describe('the drain loop', () => {
    it('drains both devices, each on its own', async () => {
      applyCharge(SRC, 50);
      applyCharge(SRC, 20, 'tablet');
      (globalThis as any).emitNet = vi.fn();

      tickAMinute();

      expect(currentCharge(SRC)).toBe(49);
      expect(currentCharge(SRC, 'tablet')).toBe(19);
      expect(phonePushes()).toEqual([['mica:client:battery:set', SRC, 49]]);
      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 19, 'tablet']]);
    });

    it('charges only the device on the charger, and the phone keeps draining', async () => {
      applyCharge(SRC, 50);
      applyCharge(SRC, 50, 'tablet');
      setCharging(SRC, true, 'tablet');

      tickAMinute();

      expect(currentCharge(SRC, 'tablet')).toBe(60);
      expect(currentCharge(SRC)).toBe(49);
    });

    it('a flat tablet stays flat and does not stop the phone draining', async () => {
      applyCharge(SRC, 0, 'tablet');
      applyCharge(SRC, 50);

      tickAMinute();

      expect(currentCharge(SRC, 'tablet')).toBe(0);
      expect(currentCharge(SRC)).toBe(49);
    });

    it("saves each device's charge to its own row", async () => {
      await sendLoadedBatteryToClient(SRC);
      await sendLoadedBatteryToClient(SRC, 'tablet');
      dbMock.update.mockClear();

      tickAMinute();
      await settle();

      expect(updates()).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([29, PHONE_A]),
          expect.arrayContaining([79, TABLET_A])
        ])
      );
    });

    it("mirrors only the phone's charge into character metadata", async () => {
      const player = mockPlayer();
      bridgeMock.getPlayer.mockReturnValue(player);

      await savePlayerBattery(SRC, 33, 'tablet');
      expect(player.setMeta).not.toHaveBeenCalled();
      await savePlayerBattery(SRC, 44);
      expect(player.setMeta).toHaveBeenCalledWith('mica_battery', 44);
    });
  });

  describe('the battery bank', () => {
    beforeEach(() => {
      applyCharge(SRC, 40);
      applyCharge(SRC, 40, 'tablet');
    });

    it('charges the tablet while the tablet is open', () => {
      setOpen(SRC, 'tablet', true);
      batteryItemHandler(SRC);

      expect(currentCharge(SRC, 'tablet')).toBe(100);
      expect(currentCharge(SRC)).toBe(40);
    });

    it('charges the phone when nothing is open', () => {
      batteryItemHandler(SRC);

      expect(currentCharge(SRC)).toBe(100);
      expect(currentCharge(SRC, 'tablet')).toBe(40);
    });

    it('charges the phone while the phone is open and the tablet closed', () => {
      setOpen(SRC, 'tablet', true);
      setOpen(SRC, 'tablet', false);
      setOpen(SRC, 'phone', true);
      batteryItemHandler(SRC);

      expect(currentCharge(SRC)).toBe(100);
      expect(currentCharge(SRC, 'tablet')).toBe(40);
    });

    it('charges the phone when a tablet is open on a server that has switched it off', () => {
      setOpen(SRC, 'tablet', true);
      tabletConvar.on = false;
      batteryItemHandler(SRC);

      expect(currentCharge(SRC)).toBe(100);
      expect(currentCharge(SRC, 'tablet')).toBe(40);
    });

    it('refuses an open tablet holding no charge, keeps the item, and leaves the phone alone', () => {
      const player = { ...mockPlayer(), removeItem: vi.fn(() => true) };
      bridgeMock.getPlayer.mockReturnValue(player);
      __resetBatteryState();
      applyCharge(SRC, 40);
      setOpen(SRC, 'tablet', true);
      (globalThis as any).emitNet = vi.fn();

      batteryItemHandler(SRC);

      expect(player.removeItem).not.toHaveBeenCalled();
      expect(currentCharge(SRC)).toBe(40);
      expect(notifies()[0]?.[2]).toMatchObject({
        type: 'error',
        key: 'server.battery.unavailable',
        params: { device: 'Tablet' }
      });
    });
  });

  describe('forgetting a source', () => {
    it('a disconnect clears every device: no charge, no charger, nothing ticked', async () => {
      applyCharge(SRC, 50);
      applyCharge(SRC, 50, 'tablet');
      setCharging(SRC, true);
      setCharging(SRC, true, 'tablet');

      dropSource(SRC);
      (globalThis as any).emitNet = vi.fn();
      tickAMinute();

      expect(chargeCalls()).toHaveLength(0);
      expect(currentCharge(SRC)).toBe(100);
      expect(currentCharge(SRC, 'tablet')).toBe(100);

      // The next player on the id: both devices drain, neither is still on a charger.
      applyCharge(SRC, 50);
      applyCharge(SRC, 50, 'tablet');
      tickAMinute();
      expect(currentCharge(SRC)).toBe(49);
      expect(currentCharge(SRC, 'tablet')).toBe(49);
    });

    it("a character switch drops the previous character's tablet and loads the new one's", async () => {
      await sendLoadedBatteryToClient(SRC);
      await sendLoadedBatteryToClient(SRC, 'tablet');
      setCharging(SRC, true, 'tablet');
      expect(currentCharge(SRC, 'tablet')).toBe(80);

      bridgeMock.getPlayer.mockReturnValue({ ...mockPlayer(), citizenid: 'OTHER001' });
      hand.tablet = TABLET_B;
      dbMock.query.mockClear();
      (globalThis as any).emitNet = vi.fn();
      // Phones still has the previous character's tablet cached: its re-resolve is async.
      handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: SRC } });
      await settle();
      await settle();
      __tickBattery();
      await settle();

      // Nothing of the previous character's tablet is loaded, ticked or shown.
      expect(queriedIds()).not.toContain(TABLET_A);
      expect(tabletPushes()).toHaveLength(0);
      expect(currentCharge(SRC, 'tablet')).toBe(100);

      // Phones re-resolves for the new character; the next tick loads the new tablet.
      inUse.tablet = TABLET_B;
      __tickBattery();
      await settle();
      await settle();
      expect(queriedIds()).toContain(TABLET_B);
      expect(currentCharge(SRC, 'tablet')).toBe(55);
      // And the previous character's charger is unplugged.
      tickAMinute();
      expect(currentCharge(SRC, 'tablet')).toBe(54);
    });
  });

  describe('switching tablets', () => {
    it("saves the old tablet's charge there and loads the new one's, leaving the phone", async () => {
      await sendLoadedBatteryToClient(SRC);
      await sendLoadedBatteryToClient(SRC, 'tablet');
      applyCharge(SRC, 25, 'tablet');
      await settle();
      // The set's own write is done and forgotten, so a 25 on the old tablet's row below can
      // only be the switch's save.
      __resetBatteryCache();
      dbMock.update.mockClear();
      dbMock.query.mockClear();
      (globalThis as any).emitNet = vi.fn();

      hand.tablet = TABLET_B;
      inUse.tablet = TABLET_B;
      await tabletStateChanged(SRC);

      expect(updates().some((p) => p[0] === 25 && p.includes(TABLET_A))).toBe(true);
      expect(currentCharge(SRC, 'tablet')).toBe(55);
      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 55, 'tablet']]);
      // The phone was neither read, saved nor pushed.
      expect(queriedIds()).not.toContain(PHONE_A);
      expect(updates().some((p) => p.includes(PHONE_A))).toBe(false);
      expect(phonePushes()).toHaveLength(0);
      expect(currentCharge(SRC)).toBe(30);
    });

    it('saves and stops ticking a tablet that is put down', async () => {
      await sendLoadedBatteryToClient(SRC, 'tablet');
      applyCharge(SRC, 25, 'tablet');
      await settle();
      dbMock.update.mockClear();

      hand.tablet = null;
      inUse.tablet = null;
      await tabletStateChanged(SRC);
      (globalThis as any).emitNet = vi.fn();
      tickAMinute();

      expect(tabletPushes()).toHaveLength(0);
      expect(currentCharge(SRC, 'tablet')).toBe(100);
    });

    it('loads a tablet picked up after the character loaded holding none', async () => {
      hand.tablet = null;
      inUse.tablet = null;
      await sendLoadedBatteryToClient(SRC, 'tablet');
      expect(tabletPushes()).toHaveLength(0);

      hand.tablet = TABLET_A;
      inUse.tablet = TABLET_A;
      await tabletStateChanged(SRC);

      expect(currentCharge(SRC, 'tablet')).toBe(80);
      expect(tabletPushes()).toEqual([['mica:client:battery:set', SRC, 80, 'tablet']]);
    });

    it('does nothing for a tablet event while the tablet is not in use', async () => {
      inUse.tablet = null;
      await tabletStateChanged(SRC);
      expect(dbMock.query).not.toHaveBeenCalled();
    });
  });

  describe('the Developer Tools slider (admin:setBattery)', () => {
    const slide = async (...args: unknown[]) => {
      (globalThis as any).source = SRC;
      handlers.get('mica:server:admin:setBattery')!(...args);
      await settle();
    };

    beforeEach(() => {
      (globalThis as any).IsPlayerAceAllowed = () => true;
      applyCharge(SRC, 50);
      applyCharge(SRC, 50, 'tablet');
    });

    it('sets the phone with no device, through the live charge the loop ticks', async () => {
      await slide(12);
      expect(currentCharge(SRC)).toBe(12);
      expect(currentCharge(SRC, 'tablet')).toBe(50);
    });

    it('sets the tablet when the tablet is named', async () => {
      await slide(12, 'tablet');
      expect(currentCharge(SRC, 'tablet')).toBe(12);
      expect(currentCharge(SRC)).toBe(50);
    });

    it('refuses the tablet for an admin with no tablet in use, seeding no charge', async () => {
      __resetBatteryState();
      inUse.tablet = null;
      (globalThis as any).emitNet = vi.fn();
      await slide(12, 'tablet');
      expect(tabletPushes()).toHaveLength(0);
      tickAMinute();
      expect(tabletPushes()).toHaveLength(0);
      expect(currentCharge(SRC, 'tablet')).toBe(100);
    });

    it('drops a device that is not one, or the tablet while it is off', async () => {
      await slide(12, 'watch');
      tabletConvar.on = false;
      await slide(12, 'tablet');
      expect(currentCharge(SRC)).toBe(50);
      expect(currentCharge(SRC, 'tablet')).toBe(50);
    });
  });
});
