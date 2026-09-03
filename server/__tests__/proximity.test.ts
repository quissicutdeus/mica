// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
  (globalThis as any).DoesEntityExist = (ped: string) => ped in coordsFor;
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

  it('respects the gos_bluetooth_range convar', async () => {
    place(1, [0, 0, 0]);
    place(2, [20, 0, 0]); // outside the default 15m, inside a widened 25m
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    (globalThis as any).GetConvarInt = () => 25;

    expect(await findNearbyVisiblePlayers(1, 'CID_A')).toEqual([{ source: 2, citizenid: 'CID_B' }]);
  });

  /**
   * MICA-115. Range was never a bound on how many: fifteen meters is a doorway on a
   * quiet street and a full club on a busy one, and every caller fans out per recipient —
   * Media's drop writes each of them a full copy of the payload. Proximity music already
   * caps its roster with `gos_music_max_nearby` for precisely this reason.
   */
  describe('the recipient cap (MICA-115)', () => {
    const crowd = (count: number) => {
      place(1, [0, 0, 0]);
      const players: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) {
        const src = i + 2;
        // Each one a meter further out than the last, all inside the 15m default.
        place(src, [i * 0.5 + 1, 0, 0]);
        players[String(src)] = { PlayerData: { citizenid: `CID_${src}` } };
      }
      (FrameworkBridge.getAllPlayers as any).mockReturnValue(players);
    };

    it('stops at the default cap rather than returning everyone in range', async () => {
      crowd(20);

      expect(await findNearbyVisiblePlayers(1, 'CID_A')).toHaveLength(5);
    });

    it('keeps the nearest, so what falls off the end is who was furthest away', async () => {
      crowd(20);

      const reached = await findNearbyVisiblePlayers(1, 'CID_A');

      // Sources were placed nearest-first from 2 outwards.
      expect(reached.map((p) => p.source)).toEqual([2, 3, 4, 5, 6]);
    });

    it('respects gos_bluetooth_max_nearby', async () => {
      crowd(20);
      (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
        name === 'gos_bluetooth_max_nearby' ? 2 : fallback;

      expect(await findNearbyVisiblePlayers(1, 'CID_A')).toHaveLength(2);
    });

    it('clamps a convar raised past the ceiling', async () => {
      crowd(20);
      (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
        name === 'gos_bluetooth_max_nearby' ? 999 : fallback;

      // A convar is a dial, not a licence: one tap writes one row per recipient.
      expect(await findNearbyVisiblePlayers(1, 'CID_A')).toHaveLength(16);
    });

    it('falls back to the default on a value that is not a positive number', async () => {
      crowd(20);
      (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
        name === 'gos_bluetooth_max_nearby' ? 0 : fallback;

      // `gos_bluetooth_range` is the knob that turns proximity sharing off; a typo in
      // this one must not silently do the same thing by another route.
      expect(await findNearbyVisiblePlayers(1, 'CID_A')).toHaveLength(5);
    });

    it('counts recipients, not candidates — invisible players never spend a slot', async () => {
      crowd(20);
      // The six nearest have Bluetooth Visibility off. Slicing before the visibility filter
      // would answer with nobody; the cap has to decide who is reached.
      settingsRepo.getValuesFor.mockResolvedValue(
        new Map([2, 3, 4, 5, 6, 7].map((src) => [`CID_${src}`, 'false']))
      );

      const reached = await findNearbyVisiblePlayers(1, 'CID_A');

      expect(reached).toHaveLength(5);
      expect(reached.map((p) => p.source)).toEqual([8, 9, 10, 11, 12]);
    });
  });

  /**
   * The same guard `signal.test.ts` pins for `pollSignal`: `GetPlayerPed` can hand back a
   * non-zero handle for a ped that is not yet synced server-side, and `GetEntityCoords`
   * throws a native argument error on it rather than returning something falsy.
   */
  it('treats a not-yet-existing ped as no coords rather than throwing', async () => {
    // Sender resolves normally through the usual fixture; player 2's ped is the phantom
    // handle — non-zero, but not yet a real entity.
    place(1, [0, 0, 0]);
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({
      2: { PlayerData: { citizenid: 'CID_B' } }
    });
    (globalThis as any).GetPlayerPed = (src: string) => (src === '2' ? 'phantom-ped' : pedFor[src]);
    (globalThis as any).GetEntityCoords = (ped: string) => {
      if (ped === 'phantom-ped') {
        throw new Error('native 000000002f7a49e6: Argument at index 1 was null.');
      }
      return coordsFor[ped] ?? null;
    };
    (globalThis as any).DoesEntityExist = (ped: string) => ped !== 'phantom-ped';

    await expect(findNearbyVisiblePlayers(1, 'CID_A')).resolves.toEqual([]);
  });
});
