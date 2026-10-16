// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MICA-353: a miss in the source registry walks the server at most once per window.
 *
 * A miss is any offline citizen — every text into a thread with an offline member — and on qb
 * the walk is a whole-server `GetQBPlayers` snapshot, so it was one per request. These pin the
 * window, every reason it is skipped, and that a player who loads is still found.
 *
 * `on` is recorded before any import, because the registry subscribes to the cores' lifecycle
 * when `FrameworkBridge` loads; every handler registered for an event is fired.
 */
const { handlers, previousOn, dbMock } = vi.hoisted(() => {
  const registered = new Map<string, ((...args: unknown[]) => void)[]>();
  const g = globalThis as Record<string, unknown>;
  const stubbedOn = g.on;
  g.on = (event: string, handler: (...args: unknown[]) => void) => {
    registered.set(event, [...(registered.get(event) ?? []), handler]);
  };
  return {
    handlers: registered,
    previousOn: stubbedOn,
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { FrameworkBridge, RESEED_INTERVAL_MS, __setResourceLookup } from '../lib/FrameworkBridge';
import { __resetAssignedNumbers } from '../lib/phoneNumbers';

const fire = (event: string, ...args: unknown[]): void => {
  for (const handler of handlers.get(event) ?? []) handler(...args);
};

afterAll(() => {
  (globalThis as Record<string, unknown>).on = previousOn;
});

/** qb-core, with a player table the test edits and a count of every whole-server walk. */
const qb = () => {
  const loaded = new Map<number, string | null>();
  const GetQBPlayers = vi.fn(() =>
    Object.fromEntries(
      [...loaded]
        .filter(([, citizenid]) => citizenid !== null)
        .map(([src, citizenid]) => [src, { PlayerData: { citizenid } }])
    )
  );
  const core = {
    Functions: {
      GetPlayer: (src: number) =>
        loaded.has(src) ? { PlayerData: { citizenid: loaded.get(src), charinfo: {} } } : null,
      GetQBPlayers
    }
  };
  __setResourceLookup((name) => (name === 'qb-core' ? { GetCoreObject: () => core } : undefined));
  return { loaded, walks: () => GetQBPlayers.mock.calls.length };
};

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetAssignedNumbers();
});
afterEach(() => {
  __setResourceLookup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('source registry reseed (MICA-353)', () => {
  it('walks once for repeated misses inside the window, and again after it', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_ONLINE');

    for (let i = 0; i < 20; i++) {
      expect(FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE')).toBeNull();
      advance(100);
    }
    expect(walks()).toBe(1);

    advance(RESEED_INTERVAL_MS);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE')).toBeNull();
    expect(walks()).toBe(2);
  });

  it('answers a loaded player outright, with no walk', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_A');
    FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');
    expect(walks()).toBe(1);

    loaded.set(2, 'CIT_B');
    FrameworkBridge.rememberSource(2);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_B')).toBe(2);
    expect(FrameworkBridge.getSourcesByCitizenId(['CIT_A', 'CIT_B'])).toEqual(
      new Map([
        ['CIT_A', 1],
        ['CIT_B', 2]
      ])
    );
    expect(walks()).toBe(1);
  });

  it('still finds a player micaOS never heard load, once the window has passed', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_A');
    FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');

    loaded.set(7, 'CIT_LATE');
    // Inside the window the miss is believed: the push is withheld, the row is still written.
    expect(FrameworkBridge.getSourceByCitizenId('CIT_LATE')).toBeNull();

    advance(RESEED_INTERVAL_MS);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_LATE')).toBe(7);
    expect(walks()).toBe(2);
  });

  it('walks at once after rememberSource could not name a player', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_A');
    FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');

    // Loaded, but the framework will not name them yet — so they are not recorded.
    loaded.set(4, null);
    FrameworkBridge.rememberSource(4);
    loaded.set(4, 'CIT_SLOW');

    expect(FrameworkBridge.getSourceByCitizenId('CIT_SLOW')).toBe(4);
    expect(walks()).toBe(2);
  });

  for (const event of ['onResourceStart', 'onResourceStop'] as const) {
    it(`walks at once after ${event} of a core`, () => {
      const { loaded, walks } = qb();
      loaded.set(1, 'CIT_A');
      FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');

      fire(event, 'ox_inventory');
      FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');
      expect(walks()).toBe(1);

      fire(event, 'qb-core');
      FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');
      expect(walks()).toBe(2);
    });
  }

  it('walks again after a walk that found nobody', () => {
    // An empty server costs nothing to walk; a framework that failed to answer must be asked
    // again, as it was before the window existed.
    // A citizenid no other test records: the registry outlives a test, the walk count does not.
    const { loaded, walks } = qb();
    expect(FrameworkBridge.getSourceByCitizenId('CIT_EMPTY')).toBeNull();
    loaded.set(1, 'CIT_EMPTY');

    expect(FrameworkBridge.getSourceByCitizenId('CIT_EMPTY')).toBe(1);
    expect(walks()).toBe(2);
  });

  it('never walks for a hit, however long it has been', () => {
    const { loaded, walks } = qb();
    loaded.set(1, 'CIT_A');
    FrameworkBridge.rememberSource(1);
    FrameworkBridge.getSourceByCitizenId('CIT_OFFLINE');
    const settled = walks();

    advance(RESEED_INTERVAL_MS * 3);
    expect(FrameworkBridge.getSourceByCitizenId('CIT_A')).toBe(1);
    expect(walks()).toBe(settled);
  });
});

/**
 * MICA-354: the id walk the timer loops read. Registry ids, walking the framework only when
 * the registry has reason to be incomplete — never once per tick.
 */
describe('onlineSources (MICA-354)', () => {
  it('fills from one walk when the registry may be incomplete, then answers without walking', () => {
    const { loaded, walks } = qb();
    loaded.set(3, 'CIT_ONLINE_3');
    loaded.set(8, 'CIT_ONLINE_8');

    // The seam marks the registry dirty, as a start does.
    expect(FrameworkBridge.onlineSources().sort((a, b) => a - b)).toEqual([3, 8]);
    for (let i = 0; i < 30; i++) FrameworkBridge.onlineSources();
    advance(RESEED_INTERVAL_MS * 4);
    FrameworkBridge.onlineSources();

    expect(walks()).toBe(1);
  });

  it('follows rememberSource and forgetSource with no walk', () => {
    const { loaded, walks } = qb();
    loaded.set(3, 'CIT_ONLINE_3');
    FrameworkBridge.onlineSources();

    loaded.set(9, 'CIT_ONLINE_9');
    FrameworkBridge.rememberSource(9);
    expect(FrameworkBridge.onlineSources().sort((a, b) => a - b)).toEqual([3, 9]);

    FrameworkBridge.forgetSource(3);
    expect(FrameworkBridge.onlineSources()).toEqual([9]);
    expect(walks()).toBe(1);
  });

  it('walks again after a core restarts, and keeps walking while it finds nobody', () => {
    const { loaded, walks } = qb();
    expect(FrameworkBridge.onlineSources()).toEqual([]);
    expect(FrameworkBridge.onlineSources()).toEqual([]);
    expect(walks()).toBe(2);

    loaded.set(4, 'CIT_ONLINE_4');
    expect(FrameworkBridge.onlineSources()).toEqual([4]);
    FrameworkBridge.onlineSources();
    expect(walks()).toBe(3);

    fire('onResourceStart', 'qb-core');
    FrameworkBridge.onlineSources();
    expect(walks()).toBe(4);
  });

  it('hands out a copy, so a caller forgetting a source mid-walk changes nothing it holds', () => {
    const { loaded } = qb();
    loaded.set(3, 'CIT_ONLINE_3');
    loaded.set(8, 'CIT_ONLINE_8');
    const ids = FrameworkBridge.onlineSources();
    FrameworkBridge.forgetSource(3);
    expect(ids.sort((a, b) => a - b)).toEqual([3, 8]);
  });
});
