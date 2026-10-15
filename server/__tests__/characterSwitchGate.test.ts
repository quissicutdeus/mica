// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-336: the character-switch gate, against the **real** `FrameworkBridge`.
 *
 * `lib/shell.ts` runs its forgetters only when a different character loads on a source. Which
 * character was there before cannot be read from the bridge's source registry, because the
 * bridge rebuilds that registry from the framework whenever a lookup misses
 * (`reseedSources`), and the framework's answer is wrong at both ends of a qbx switch:
 *
 * - **Logout** sets `QBX.Players[src] = nil` (`qbx_core/server/player.lua:754`), and the player
 *   then sits on character select for as long as they like. A push or a message addressed to
 *   the character who left misses, the rebuild drops the source, and the next character loads
 *   over nobody — so nothing was forgotten.
 * - **Login** sets `QBX.Players[src]` to the new character and awaits before it fires
 *   `QBCore:Server:PlayerLoaded` (`player.lua:1054-1064`). A rebuild in that gap records the
 *   new character early, so the load looked like the same one announced again.
 *
 * So the shell keeps its own record of who it last dispatched as loaded on each source, and
 * nothing rebuilds it. Only the database is mocked here: the bridge, its qbx adapter and the
 * shell are the shipped ones, over a stand-in `qbx_core` whose player table each case moves.
 */
const { dbMock, handlers } = vi.hoisted(() => {
  // A list per event: the shell and the bridge's neighbours both listen to `playerDropped`.
  const captured = new Map<string, Function[]>();
  const capture = (event: string, handler: Function) => {
    captured.set(event, [...(captured.get(event) ?? []), handler]);
  };
  (globalThis as any).on = capture;
  (globalThis as any).onNet = capture;
  return {
    handlers: captured,
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { forgetOnPlayerLoaded } from '../lib/shell';
import { FrameworkBridge, __setResourceLookup } from '../lib/FrameworkBridge';

const SRC = 7;

/** `QBX.Players`, as qbx_core holds it: source → Player, and a hole where a logout left one. */
const players = new Map<number, { PlayerData: { citizenid: string; source: number } }>();
const seat = (src: number, citizenid: string) =>
  players.set(src, { PlayerData: { citizenid, source: src } });

const forgot = vi.fn();
forgetOnPlayerLoaded('gate-under-test', forgot);

/** qbx_core's own local announcement, fired inside its character load. */
const announce = (src: number) => {
  for (const handler of handlers.get('QBCore:Server:PlayerLoaded') ?? []) {
    handler({ PlayerData: { source: src } });
  }
};

const drop = (src: number) => {
  (globalThis as any).source = src;
  for (const handler of handlers.get('playerDropped') ?? []) handler();
};

/** Any lookup that misses — a push to somebody offline — and so rebuilds the bridge registry. */
const rebuildRegistry = () => {
  expect(FrameworkBridge.getSourceByCitizenId('CID_NOBODY')).toBeNull();
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  (globalThis as any).emitNet = vi.fn();
  players.clear();
  __setResourceLookup((name) =>
    name === 'qbx_core'
      ? {
          GetPlayer: (src: number) => players.get(Number(src)) ?? null,
          GetQBPlayers: () => Object.fromEntries(players)
        }
      : undefined
  );
  drop(SRC);
  forgot.mockClear();
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('the character-switch gate reads its own record, not the bridge registry', () => {
  it('forgets the previous character when the registry was rebuilt while they were gone', () => {
    seat(SRC, 'CID_A');
    announce(SRC);
    expect(forgot).not.toHaveBeenCalled();

    // Logout: qbx empties the slot, and a push to A misses and rebuilds the registry.
    players.delete(SRC);
    rebuildRegistry();

    seat(SRC, 'CID_B');
    announce(SRC);

    expect(forgot).toHaveBeenCalledTimes(1);
    expect(forgot).toHaveBeenCalledWith(SRC, 'CID_A');
  });

  it('forgets the previous character when a rebuild recorded the new one before its load', () => {
    seat(SRC, 'CID_A');
    announce(SRC);

    // Login has seated B and is still awaiting; a miss rebuilds the registry from it.
    seat(SRC, 'CID_B');
    rebuildRegistry();
    expect(FrameworkBridge.getSourceByCitizenId('CID_B')).toBe(SRC);

    announce(SRC);

    expect(forgot).toHaveBeenCalledWith(SRC, 'CID_A');
  });

  it('forgets nothing when the same character is announced again, rebuild or not', () => {
    seat(SRC, 'CID_A');
    announce(SRC);
    rebuildRegistry();

    announce(SRC);

    expect(forgot).not.toHaveBeenCalled();
  });

  it('forgets nothing for a new connection: the drop already cleared the source', () => {
    seat(SRC, 'CID_A');
    announce(SRC);
    drop(SRC);

    seat(SRC, 'CID_B');
    announce(SRC);

    expect(forgot).not.toHaveBeenCalled();
  });
});
