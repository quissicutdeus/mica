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
  batteryApp,
  currentCharge,
  runChargeCommand,
  savePlayerBattery,
  sendLoadedBatteryToClient,
  setCharging,
  __resetBatteryCache,
  __resetBatteryState,
  __tickBattery
} from '../services/Battery';

const SRC = 7;
const CID = 'ABC12345';

const mockPlayer = (metadata: Record<string, unknown> = {}) => ({
  citizenid: CID,
  source: SRC,
  setMeta: vi.fn(),
  rawPlayer: { PlayerData: { metadata } }
});

/** The last `emitNet('gphone:client:battery:set', ...)` level, or undefined. */
const emittedCharge = (): number | undefined => {
  const call = (globalThis.emitNet as any).mock.calls
    .filter((c: any[]) => c[0] === 'gphone:client:battery:set')
    .pop();
  return call?.[2];
};

beforeEach(() => {
  // The shared setup installs a plain noop; this suite needs to read the calls.
  globalThis.emitNet = vi.fn() as any;
  vi.clearAllMocks();
  __resetBatteryCache();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
});

describe('battery table declaration', () => {
  it('is server-authored, so no column is client-writable', () => {
    expect(batteryApp.repo.writableColumns).toEqual([]);
  });

  it('carries a unique index on citizenid, so a player cannot end up with two rows', () => {
    const unique = batteryApp.resolved.indexes.filter((i) => i.unique);
    expect(unique).toEqual([{ name: 'citizenid_unique', columns: ['citizenid'], unique: true }]);
  });
});

describe('savePlayerBattery', () => {
  it('inserts a row when the player has none', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());

    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledOnce();
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(sql).toContain('INSERT INTO `gphone_battery`');
    expect(params).toEqual(expect.arrayContaining([CID, 42]));
  });

  it('updates the existing row rather than inserting a second', async () => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    dbMock.query.mockResolvedValue([{ id: 3, citizenid: CID, level: 90 }]);

    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).not.toHaveBeenCalled();
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(sql).toContain('UPDATE `gphone_battery`');
    // Ownership-scoped: the citizenid is in the WHERE clause, not just the lookup.
    expect(sql).toContain('AND `citizenid` = ?');
    expect(params).toEqual([42, 3, CID]);
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
    const player = mockPlayer({ gphone_battery: 55 });
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
  (globalThis.emitNet as any).mock.calls.filter(
    (c: any[]) => c[0] === 'gphone:client:shell:notify'
  );
const chargeCalls = () =>
  (globalThis.emitNet as any).mock.calls.filter((c: any[]) => c[0] === 'gphone:client:battery:set');

describe('gphonecharge command', () => {
  beforeEach(() => {
    bridgeMock.getPlayer.mockReturnValue(mockPlayer());
    (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
    (globalThis as any).IsPlayerAceAllowed = () => false;
  });

  it('accepts a server admin holding `command` but not gphone.admin', async () => {
    // The command ran its own `gphone.admin` check rather than going through isAdmin,
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
    bridgeMock.getPlayer.mockReturnValue(playerFor(CID));

    await savePlayerBattery(SRC, 42);
    expect(dbMock.insert).toHaveBeenCalledOnce();

    for (let i = 0; i < limit; i += 1) {
      bridgeMock.getPlayer.mockReturnValue(playerFor(`CID_${i}`));
      await savePlayerBattery(SRC, 42);
    }

    // The first character has aged out, so its next report is a write rather than a skip.
    bridgeMock.getPlayer.mockReturnValue(playerFor(CID));
    await savePlayerBattery(SRC, 42);

    expect(dbMock.insert).toHaveBeenCalledTimes(limit + 2);
  });
});
