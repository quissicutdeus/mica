import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getAllPlayers: vi.fn(() => ({})) }
}));

const settingsRepo = vi.hoisted(() => ({ getValuesFor: vi.fn(async () => new Map()) }));
vi.mock('../services/Settings', () => ({
  getSettingsRepository: () => settingsRepo
}));

import { FrameworkBridge } from '../lib/FrameworkBridge';
import { findNearbyVisiblePlayers } from '../lib/proximity';

const pedFor: Record<string, string> = {};
const coordsFor: Record<string, [number, number, number]> = {};

const place = (src: number, coords: [number, number, number]) => {
  pedFor[String(src)] = `ped-${src}`;
  coordsFor[`ped-${src}`] = coords;
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsRepo.getValuesFor.mockResolvedValue(new Map());
  for (const key of Object.keys(pedFor)) delete pedFor[key];
  for (const key of Object.keys(coordsFor)) delete coordsFor[key];
  (globalThis as any).GetPlayerPed = (src: string) => pedFor[src] ?? null;
  (globalThis as any).GetEntityCoords = (ped: string) => coordsFor[ped] ?? null;
  (globalThis as any).GetConvarInt = (_name: string, fallback: number) => fallback;
});

describe('findNearbyVisiblePlayers', () => {
  it('finds nobody when the sender has no ped yet', async () => {
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    place(2, [0, 0, 0]);
    // Sender (source 1) is never placed.

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([]);
  });

  it('includes a visible player inside range and excludes one outside it', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]); // within the default 15m range
    place(3, [100, 0, 0]); // outside it
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } },
      3: { PlayerData: { citizenid: 'CID_C' } }
    });

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([{ source: 2, citizenid: 'CID_B' }]);
  });

  it('excludes a nearby player who turned Bluetooth Visibility off', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    settingsRepo.getValuesFor.mockResolvedValue(new Map([['CID_B', 'false']]));

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([]);
  });

  it('defaults visibility to on when no setting row has ever synced', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    settingsRepo.getValuesFor.mockResolvedValue(new Map());

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([{ source: 2, citizenid: 'CID_B' }]);
  });

  it('excludes the sender, regardless of their own visibility', async () => {
    place(1, [0, 0, 0]);
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      1: { PlayerData: { citizenid: 'CID_A' } }
    });

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([]);
  });

  it('respects the gphone_bluetooth_range convar', async () => {
    place(1, [0, 0, 0]);
    place(2, [20, 0, 0]); // outside the default 15m, inside a widened 25m
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    (globalThis as any).GetConvarInt = () => 25;

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([{ source: 2, citizenid: 'CID_B' }]);
  });
});
