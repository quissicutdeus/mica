// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: vi.fn(() => ({ citizenid: 'CID' })),
    // The server evaluates every connected player now, so changing the rules walks the
    // player list rather than broadcasting to it.
    getAllPlayers: vi.fn(() => ({})),
    registerUsableItem: vi.fn()
  }
}));

import { FrameworkBridge } from '../lib/FrameworkBridge';
import {
  addDeadZone,
  currentRules,
  playerOverride,
  pollSignal,
  removeDeadZone,
  setGlobalSignal,
  setPlayerSignal,
  __resetSignal,
  evaluateSignal,
  FULL_SIGNAL
} from '../services/Signal';

beforeEach(() => {
  __resetSignal();
  (globalThis as any).emitNet = vi.fn();
});

/**
 * Reception: a global level, dead zones, and per-player overrides.
 *
 * The precedence rule is the whole design, and it is the thing worth pinning — a city-wide
 * outage and a jammer are deliberately the **same primitive** rather than two mechanisms,
 * because two would drift the first time they disagreed.
 */
describe('signal rules', () => {
  it('starts at full bars with nothing to say otherwise', () => {
    expect(currentRules()).toEqual({ global: FULL_SIGNAL, zones: [] });
  });

  it('clamps a level rather than refusing it', () => {
    expect(setGlobalSignal(99)).toBe(FULL_SIGNAL);
    expect(setGlobalSignal(-5)).toBe(0);
  });

  it('never sends the zone list to a client', () => {
    // The client evaluated its own position once, which meant it held the zones. It does
    // not now, and must not: a client that cannot see the zones cannot decide it is
    // outside one.
    setGlobalSignal(1);
    addDeadZone({ x: 0, y: 0, z: 0, radius: 50, level: 0 });

    const events = (globalThis.emitNet as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(events).not.toContain('gos:client:signal:rules');
  });

  it('hands back an id, which is the only thing a caller can do with a zone', () => {
    const zone = addDeadZone({ x: 1, y: 2, z: 3, radius: 50, level: 0 });
    expect(zone.id).toBeGreaterThan(0);
    expect(removeDeadZone(zone.id)).toBe(true);
    expect(removeDeadZone(zone.id)).toBe(false);
    expect(currentRules().zones).toEqual([]);
  });

  it('keeps an override per source and clears it with null', () => {
    setPlayerSignal(7, 0);
    expect(playerOverride(7)).toBe(0);
    setPlayerSignal(7, null);
    expect(playerOverride(7)).toBeNull();
  });

  /**
   * `GetPlayerPed` can hand back a non-zero handle for a player whose ped is not yet
   * synced server-side — the window right around `QBCore:Server:OnPlayerLoaded`. The
   * `!ped` guard only catches a falsy handle; it does not catch this one, and
   * `GetEntityCoords` throws on it rather than returning something falsy. Unguarded, that
   * exception was uncaught inside `pollSignal`'s loop, which is a `setInterval` callback —
   * so it crashed silently in the game console every two seconds and, worse, aborted the
   * poll partway through, leaving every player after the failing one un-updated that cycle.
   */
  it('does not crash when a native throws for a not-yet-existing ped', () => {
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({ 5: {} });
    (globalThis as any).GetPlayerPed = () => 999;
    (globalThis as any).GetEntityCoords = () => {
      throw new Error('native 000000002f7a49e6: Argument at index 1 was null.');
    };
    (globalThis as any).DoesEntityExist = () => false;

    try {
      // Breaks the `worldIsQuiet` early-out, so `pollSignal` actually has to ask where
      // player 5 is rather than skipping straight to full bars for everyone.
      expect(() => setGlobalSignal(1)).not.toThrow();

      // No ped yet beats a spurious blackout — the same fallback an unspawned player
      // already gets.
      const pushed = (globalThis.emitNet as any).mock.calls.find(
        (c: unknown[]) => c[0] === 'gos:client:signal:set' && c[1] === 5
      );
      expect(pushed?.[2]).toBe(FULL_SIGNAL);
    } finally {
      delete (globalThis as any).GetPlayerPed;
      delete (globalThis as any).GetEntityCoords;
      delete (globalThis as any).DoesEntityExist;
      (FrameworkBridge.getAllPlayers as any).mockReturnValue({});
    }
  });

  /**
   * `FrameworkBridge.getAllPlayers()` can list a player slightly before FiveM's own
   * networking layer has fully attached their connection — the window right around join.
   * `emitNet` to a source in that state throws a native argument error
   * ("native ...: Argument at index 1 was null.") rather than failing quietly, and with no
   * guard it would recur every two-second poll until the player finished connecting.
   * `GetPlayerName` is the standard "is this actually a live client" check.
   */
  it('skips a source GetPlayerName says is not really connected yet, and retries once they are', () => {
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({ 5: {}, 6: {} });
    let connected = false;
    (globalThis as any).GetPlayerName = (src: string) => (src === '5' && !connected ? '' : 'Bob');

    try {
      pollSignal();

      const pushedTo = () =>
        (globalThis.emitNet as any).mock.calls
          .filter((c: unknown[]) => c[0] === 'gos:client:signal:set')
          .map((c: unknown[]) => c[1]);
      expect(pushedTo()).not.toContain(5);
      expect(pushedTo()).toContain(6);

      // The point of not marking `lastPushed` for a skipped player: the very next poll
      // still tries them again, rather than treating the skip as "already told them".
      connected = true;
      pollSignal();
      expect(pushedTo()).toContain(5);
    } finally {
      delete (globalThis as any).GetPlayerName;
      (FrameworkBridge.getAllPlayers as any).mockReturnValue({});
    }
  });

  /**
   * Defense-in-depth for the same race slipping past the `GetPlayerName` check in the
   * instant between the check and the send: one player's `emitNet` throwing must not stop
   * the rest of that tick's players from getting their update, the same failure mode
   * `playerCoords.ts`'s own guard exists to avoid for `GetEntityCoords`.
   */
  it('does not let one bad emitNet target abort the rest of the poll, and retries it next time', () => {
    (FrameworkBridge.getAllPlayers as any).mockReturnValue({ 5: {}, 6: {} });
    let failing = true;
    (globalThis.emitNet as any).mockImplementation((event: string, src: number) => {
      if (event === 'gos:client:signal:set' && src === 5 && failing) {
        throw new Error('native 000000002f7a49e6: Argument at index 1 was null.');
      }
    });

    const attemptsFor = (src: number) =>
      (globalThis.emitNet as any).mock.calls.filter(
        (c: unknown[]) => c[0] === 'gos:client:signal:set' && c[1] === src
      ).length;

    expect(() => pollSignal()).not.toThrow();
    expect(attemptsFor(6)).toBe(1);
    // The throwing call is still attempted once (and recorded, since a mock records a
    // call whether or not its implementation throws) — the assertion that matters is the
    // *next* one below.
    expect(attemptsFor(5)).toBe(1);

    // A throw must not be mistaken for a delivery: the next poll has to try player 5
    // again rather than treating the failed call as "already told them".
    failing = false;
    pollSignal();
    expect(attemptsFor(5)).toBe(2);

    (FrameworkBridge.getAllPlayers as any).mockReturnValue({});
  });
});

const rules = (global: number, zones: any[] = []) => ({ global, zones });
const zone = (over: Partial<any> = {}) => ({
  id: 1,
  x: 0,
  y: 0,
  z: 0,
  radius: 100,
  level: 0,
  ...over
});

describe('the precedence order', () => {
  it('is full bars when nothing applies', () => {
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL), null)).toBe(FULL_SIGNAL);
  });

  it('takes the lowest of the global level and any zone the player is inside', () => {
    // The same primitive, not two mechanisms: a blackout is a global level, a jammer is a
    // zone, and whichever is worse is what you get.
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, [zone({ level: 1 })]), null)).toBe(1);
    expect(evaluateSignal(0, 0, 0, rules(2, [zone({ level: 3 })]), null)).toBe(2);
  });

  it('ignores a zone the player is outside', () => {
    expect(evaluateSignal(500, 500, 0, rules(FULL_SIGNAL, [zone({ level: 0 })]), null)).toBe(
      FULL_SIGNAL
    );
  });

  it('measures in three dimensions, so a basement is not the street above it', () => {
    // A radius check that ignored z would black out every floor of a building because one
    // room in it has a jammer.
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, [zone({ radius: 10 })]), null)).toBe(0);
    expect(evaluateSignal(0, 0, 40, rules(FULL_SIGNAL, [zone({ radius: 10 })]), null)).toBe(
      FULL_SIGNAL
    );
  });

  it('lets a per-player override win outright, including upward', () => {
    // It is set *at* a player rather than at the world, so it is not part of the
    // lowest-wins comparison — otherwise there would be no way to give somebody bars
    // inside a blackout, which is the whole point of the override.
    expect(evaluateSignal(0, 0, 0, rules(0, [zone({ level: 0 })]), FULL_SIGNAL)).toBe(FULL_SIGNAL);
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL), 0)).toBe(0);
  });

  it('takes the worst of several overlapping zones', () => {
    const overlapping = [zone({ id: 1, level: 3 }), zone({ id: 2, level: 1 })];
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, overlapping), null)).toBe(1);
  });
});
