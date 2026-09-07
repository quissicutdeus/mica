// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock, handlers } = vi.hoisted(() => {
  // Inside `vi.hoisted` because ESM evaluates imports first: assigning `on`/`onNet`
  // below the imports would run after the service registered and capture nothing.
  const captured = new Map<string, Function>();
  const captureHandler = (event: string, handler: Function) => {
    captured.set(event, handler);
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
    bridgeMock: { getPlayer: vi.fn(), registerUsableItem: vi.fn() },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

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
 * Matched by item name rather than by position, because `phoneItem.ts` registers through the
 * same mock when `mica_phone_item` is set.
 */
const batteryItemHandler: (src: number) => void = bridgeMock.registerUsableItem.mock.calls.find(
  (call: unknown[]) => call[0] === 'battery_bank'
)?.[1];
import { __resetRateLimits } from '../lib/rateLimit';
import { __setPhoneResolvers } from '../lib/phoneIdentity';
import { TEST_PHONE_ID } from './phoneStub';

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

  it('still sends a level when the read throws', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendLoadedBatteryToClient(SRC);

    // A dead database must not leave the phone with no charge value at all.
    expect(emittedCharge()).toBe(100);
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
    const { __phoneStateSubscribers } = await import('../lib/phoneItem');
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
    const { PlayerFacingError } = await import('../lib/errors');
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
