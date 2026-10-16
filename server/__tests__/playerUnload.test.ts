// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MICA-382: a character logged out to character select stops being addressable.
 *
 * A multichar logout keeps the connection and FiveM fires no `playerDropped`, so the source
 * registry kept answering the character who left with the source now sitting on character
 * select, and a push meant for them landed there. These drive the real `lib/shell.ts`
 * listeners into the real `FrameworkBridge` registry, over a qb-core stub whose player table
 * the test edits, and push through the real `appEventChannel`.
 *
 * `on` and `onNet` are recorded before any import, separately, because which registrar a name
 * went through is the security property: an `onNet` unload listener would let any client make
 * the server forget another player's source.
 */
const { handlers, networked, previous, dbMock } = vi.hoisted(() => {
  const registered = new Map<string, ((...args: unknown[]) => void)[]>();
  const overNet = new Set<string>();
  const g = globalThis as Record<string, unknown>;
  const kept = { on: g.on, onNet: g.onNet };
  const capture = (event: string, handler: (...args: unknown[]) => void) => {
    registered.set(event, [...(registered.get(event) ?? []), handler]);
  };
  g.on = capture;
  g.onNet = (event: string, handler: (...args: unknown[]) => void) => {
    overNet.add(event);
    capture(event, handler);
  };
  return {
    handlers: registered,
    networked: overNet,
    previous: kept,
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { FrameworkBridge, RESEED_INTERVAL_MS, __setResourceLookup } from '../lib/FrameworkBridge';
import { PLAYER_UNLOADED_EVENTS } from '../lib/shell';
import { appEventChannel } from '../lib/appEvents';
import { __resetAssignedNumbers } from '../lib/phoneNumbers';
import { isDeviceLocked, setDeviceLocked, __resetLockState } from '../lib/LockState';
import { playerOverride, setPlayerSignal, __resetSignal } from '../services/Signal';

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.on = previous.on;
  g.onNet = previous.onNet;
});

const fire = (event: string, ...args: unknown[]): void => {
  for (const handler of handlers.get(event) ?? []) handler(...args);
};

const SRC = 3;

/** qb-core, with a player table the test edits and a count of every whole-server walk. */
const qb = () => {
  const loaded = new Map<number, string>();
  /** Loaded, but `GetPlayer` will not name them yet. */
  const unnamed = new Set<number>();
  const GetQBPlayers = vi.fn(() =>
    Object.fromEntries(
      [...loaded].map(([src, citizenid]) => [src, { PlayerData: { citizenid, source: src } }])
    )
  );
  const core = {
    Functions: {
      GetPlayer: (src: number) =>
        loaded.has(src) && !unnamed.has(src)
          ? { PlayerData: { citizenid: loaded.get(src), source: src, charinfo: {} } }
          : null,
      GetQBPlayers
    }
  };
  __setResourceLookup((name) => (name === 'qb-core' ? { GetCoreObject: () => core } : undefined));
  return { loaded, unnamed, walks: () => GetQBPlayers.mock.calls.length };
};

/** A character finishing its load, the way qbx_core and qb-core announce it in-process. */
const load = (loaded: Map<number, string>, src: number, citizenid: string): void => {
  loaded.set(src, citizenid);
  fire('QBCore:Server:PlayerLoaded', { PlayerData: { source: src } });
};

/** The real `playerDropped` cleanup, for the source the runtime says dropped. */
const drop = (src: number): void => {
  const g = globalThis as Record<string, unknown>;
  const was = g.source;
  g.source = src;
  fire('playerDropped');
  g.source = was;
};

const channel = appEventChannel('dispatch');
const pushTo = (citizenid: string) => channel.push(citizenid, 'incoming', { id: 1 });
const pushes = () =>
  (globalThis.emitNet as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([event]) => event === 'mica:client:shell:appEvent'
  );

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  globalThis.emitNet = vi.fn() as never;
  __resetAssignedNumbers();
  __resetLockState();
});
afterEach(() => {
  drop(SRC);
  __setResourceLookup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the unload listeners', () => {
  it.each(Object.entries(PLAYER_UNLOADED_EVENTS))(
    '%s (%s) is registered locally and is not reachable over the network',
    (_key, event) => {
      expect(handlers.get(event)).toHaveLength(1);
      expect(networked.has(event)).toBe(false);
    }
  );

  it('the harness can tell the two registrars apart', () => {
    expect(networked.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
  });
});

describe('a push to a character who logged out (MICA-382)', () => {
  it('reaches their connection while they are loaded', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');

    expect(pushTo('CIT_LEFT')).toEqual({ delivered: true, source: SRC });
    expect(pushes()).toHaveLength(1);
  });

  it.each(Object.entries(PLAYER_UNLOADED_EVENTS))(
    'reaches nobody after %s (%s), with the source still connected',
    (_key, event) => {
      const { loaded } = qb();
      load(loaded, SRC, 'CIT_LEFT');

      fire(event, SRC);
      // qbx clears the player after its `Wait(200)`, qb-core at once, ESX in a save's callback.
      loaded.delete(SRC);

      expect(pushTo('CIT_LEFT')).toEqual({ delivered: false, reason: 'offline' });
      expect(pushes()).toHaveLength(0);
    }
  );

  it('reaches nobody while the core still lists them, and a walk does not put them back', () => {
    const { loaded, walks } = qb();
    load(loaded, SRC, 'CIT_LEFT');

    // qbx_core announces the unload, then `Wait(200)`, then clears the player.
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    expect(pushTo('CIT_LEFT')).toEqual({ delivered: false, reason: 'offline' });

    advance(RESEED_INTERVAL_MS);
    expect(pushTo('CIT_LEFT')).toEqual({ delivered: false, reason: 'offline' });
    expect(walks()).toBeGreaterThan(0);
    expect(FrameworkBridge.onlineSources()).not.toContain(SRC);
    expect(pushes()).toHaveLength(0);
  });

  it('does not mark the registry dirty: the next miss waits out the window', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_OTHER');
    FrameworkBridge.getSourceByCitizenId('CIT_NOBODY');
    load(loaded, SRC, 'CIT_LEFT');
    const before = walks();

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    loaded.delete(SRC);
    pushTo('CIT_LEFT');

    expect(walks()).toBe(before);
  });

  it('reaches the next character who loads on the source, and not the one who left', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    loaded.delete(SRC);

    load(loaded, SRC, 'CIT_NEXT');

    expect(pushTo('CIT_NEXT')).toEqual({ delivered: true, source: SRC });
    expect(pushTo('CIT_LEFT')).toEqual({ delivered: false, reason: 'offline' });
  });

  it('reaches the same character again once they pick them again', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    loaded.delete(SRC);

    load(loaded, SRC, 'CIT_LEFT');
    expect(pushTo('CIT_LEFT')).toEqual({ delivered: true, source: SRC });

    // A reseed rebuilds the registry wholesale, so a logout still recorded would drop them now.
    advance(RESEED_INTERVAL_MS);
    FrameworkBridge.getSourceByCitizenId('CIT_NOBODY');
    expect(pushTo('CIT_LEFT')).toEqual({ delivered: true, source: SRC });
  });

  it('reaches them again when they re-pick and the load could not name them at first', () => {
    const { loaded, unnamed } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);

    // The load is announced before the core will name them, so it records nobody.
    unnamed.add(SRC);
    load(loaded, SRC, 'CIT_LEFT');
    unnamed.delete(SRC);

    expect(pushTo('CIT_LEFT')).toEqual({ delivered: true, source: SRC });
  });

  it('still finds a different character seated before micaOS hears them load', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    // Seated by the core, not yet announced: only a walk can find them.
    loaded.set(SRC, 'CIT_NEXT');

    advance(RESEED_INTERVAL_MS);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_NEXT')).toBe(SRC);
  });

  it('forgets the logout when the source drops, so a rejoin on the id is found', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    drop(SRC);

    // The same character on the same recycled id, after a restart of nothing but the client.
    loaded.set(SRC, 'CIT_LEFT');
    advance(RESEED_INTERVAL_MS);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_LEFT')).toBe(SRC);
  });

  it('records the logout even when the registry never heard them load', () => {
    const { loaded } = qb();
    // Loaded before a resource restart: present to the core, absent from the registry.
    loaded.set(SRC, 'CIT_LEFT');

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);

    expect(pushTo('CIT_LEFT')).toEqual({ delivered: false, reason: 'offline' });
  });

  it.each([0, -1, 1.5, Number.NaN, '3', undefined, null, { source: SRC }])(
    'ignores an unload naming %s rather than a server id',
    (named) => {
      const { loaded } = qb();
      load(loaded, SRC, 'CIT_LEFT');

      fire(PLAYER_UNLOADED_EVENTS.qbLocal, named);
      fire(PLAYER_UNLOADED_EVENTS.esxLocal, named);

      expect(pushTo('CIT_LEFT')).toEqual({ delivered: true, source: SRC });
    }
  );

  it("forgets only the source it names, and nobody else's", () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    load(loaded, 5, 'CIT_STAYED');

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);

    expect(pushTo('CIT_STAYED')).toEqual({ delivered: true, source: 5 });
    drop(5);
  });
});

/**
 * What a script set on the character rather than the session (MICA-382): a lock set on the player
 * before their device resolved, which is keyed by source, and a signal override — a jail, a
 * tinfoil hat. Both forgetters wait for a different character's load (`atLogout: false`), so the
 * next character never inherits either and a relog to the same one does not escape it.
 * `LockState`'s and `Signal`'s own forgetters are the real ones here.
 */
describe('a source-level lock and a signal override across a logout (MICA-382)', () => {
  const setBoth = () => {
    setDeviceLocked(SRC, 'phone', true);
    setDeviceLocked(SRC, 'tablet', true);
    setPlayerSignal(SRC, 0);
  };
  const expectBoth = (held: boolean) => {
    expect(isDeviceLocked(SRC, 'phone')).toBe(held);
    expect(isDeviceLocked(SRC, 'tablet')).toBe(held);
    expect(playerOverride(SRC)).toBe(held ? 0 : null);
  };

  beforeEach(() => {
    __resetSignal();
  });

  it('survive the same character logging out and being picked again', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    setBoth();

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    expectBoth(true);
    load(loaded, SRC, 'CIT_LEFT');

    expectBoth(true);
  });

  it('are cleared when a different character loads after the logout', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    setBoth();

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    load(loaded, SRC, 'CIT_NEXT');

    expectBoth(false);
  });

  /**
   * qbx and ESX still name the character for a moment after announcing the unload — qbx's
   * `Wait(200)`, ESX's save — so a resource can still set either on them then.
   */
  it('are cleared when they were set in the unload window and a different character loads', () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);
    setBoth();

    load(loaded, SRC, 'CIT_NEXT');

    expectBoth(false);
  });

  it("leaves another player's lock alone", () => {
    const { loaded } = qb();
    load(loaded, SRC, 'CIT_LEFT');
    load(loaded, 5, 'CIT_STAYED');
    setDeviceLocked(5, 'phone', true);

    fire(PLAYER_UNLOADED_EVENTS.qbLocal, SRC);

    expect(isDeviceLocked(5, 'phone')).toBe(true);
    drop(5);
  });
});
