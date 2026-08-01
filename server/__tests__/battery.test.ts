import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  },
  // registerUsableItem runs at import time; the rest is only what this suite drives.
  bridgeMock: { getPlayer: vi.fn(), registerUsableItem: vi.fn() }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import {
  batteryApp,
  savePlayerBattery,
  sendLoadedBatteryToClient,
  __resetBatteryCache
} from '../controllers/BatteryController';

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
