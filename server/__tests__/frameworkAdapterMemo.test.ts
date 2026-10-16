// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MICA-352: which adapter serves is remembered, not re-probed per call.
 *
 * FiveM's `exports` proxy throws for a resource that is not running and caches only exports
 * that exist, so every probe for a missing core was a caught throw on every `getPlayer`. The
 * lookup below throws the same way and counts each resource it is asked for.
 *
 * What must still hold: "unknown" during the boot window is never remembered, and a core
 * starting or stopping drops whatever was. `on` is recorded before any import, because the
 * memo subscribes when `FrameworkBridge` loads, and every handler for an event is fired.
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

import {
  FrameworkBridge,
  STANDALONE_CONVAR,
  __resetStandaloneWarnings,
  __setResourceLookup,
  detectFramework
} from '../lib/FrameworkBridge';
import { __resetAssignedNumbers } from '../lib/phoneNumbers';

const fire = (event: string, ...args: unknown[]): void => {
  for (const handler of handlers.get(event) ?? []) handler(...args);
};

const g = globalThis as Record<string, unknown>;
const previousConvar = g.GetConvar;

afterAll(() => {
  g.on = previousOn;
  g.GetConvar = previousConvar;
});

/** `exports`, as FiveM answers it: a running resource, or a throw. Counts every lookup. */
const server = (running: Record<string, unknown>) => {
  const asked = new Map<string, number>();
  __setResourceLookup((name) => {
    asked.set(name, (asked.get(name) ?? 0) + 1);
    if (!(name in running)) throw new Error(`No such export ${name}`);
    return running[name];
  });
  return { asked: (name: string) => asked.get(name) ?? 0, running };
};

const convar = vi.fn((_name: string, fallback: string) => fallback);
const setStandalone = (on: boolean) =>
  convar.mockImplementation((name: string, fallback: string) =>
    name === STANDALONE_CONVAR && on ? '1' : fallback
  );

const qbCore = (citizenid: string) => ({
  GetCoreObject: () => ({
    Functions: {
      GetPlayer: () => ({ PlayerData: { citizenid, charinfo: {} } }),
      GetQBPlayers: () => ({ 1: { PlayerData: { citizenid } } })
    }
  })
});

const LICENSE = `license:${'a'.repeat(40)}`;
const esxCore = () => ({
  getSharedObject: () => ({
    GetPlayerFromId: (src: number) => ({
      identifier: LICENSE,
      source: src,
      variables: {},
      get: () => undefined,
      getName: () => 'Ada Lovelace'
    }),
    GetExtendedPlayers: () => []
  })
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetAssignedNumbers();
  __resetStandaloneWarnings();
  setStandalone(false);
  convar.mockClear();
  g.GetConvar = convar;
});
afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('remembered adapter (MICA-352)', () => {
  it('probes the missing qbx_core once on a qb-core server, not once per call', () => {
    const { asked } = server({ 'qb-core': qbCore('CIT_A') });

    for (let i = 0; i < 25; i++) {
      expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
      expect(detectFramework()).toBe('qb');
    }
    FrameworkBridge.getAllPlayers();
    FrameworkBridge.getAllPlayers();

    // Once each for: detection, the getPlayer choice, the getAllPlayers choice.
    expect(asked('qbx_core')).toBe(3);
  });

  it('probes both qb cores a bounded number of times on ESX', () => {
    const { asked } = server({ es_extended: esxCore() });

    for (let i = 0; i < 25; i++) {
      expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE);
      expect(detectFramework()).toBe('esx');
      FrameworkBridge.getAllPlayers();
    }

    expect(asked('qbx_core')).toBe(3);
    expect(asked('qb-core')).toBe(3);
  });

  it('reads the standalone convar once rather than per call', () => {
    setStandalone(true);
    const { asked } = server({});

    for (let i = 0; i < 25; i++) {
      expect(detectFramework()).toBe('standalone');
      FrameworkBridge.getPlayer(1);
      FrameworkBridge.getAllPlayers();
    }

    expect(convar.mock.calls.filter(([name]) => name === STANDALONE_CONVAR)).toHaveLength(1);
    // Detection and the two method choices, each once — it was about six per call.
    expect(asked('qbx_core')).toBe(3);
  });

  it('never remembers "unknown": a core that comes up later is found with no event', () => {
    const { running } = server({});

    expect(detectFramework()).toBe('unknown');
    expect(FrameworkBridge.getPlayer(1)).toBeNull();

    running['qb-core'] = qbCore('CIT_A');
    expect(detectFramework()).toBe('qb');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
  });

  it('drops a remembered standalone answer when a core starts', () => {
    setStandalone(true);
    const { running } = server({});
    expect(detectFramework()).toBe('standalone');

    running['qb-core'] = qbCore('CIT_A');
    // Remembered until the event: proof that the answer really is held.
    expect(detectFramework()).toBe('standalone');

    fire('onResourceStart', 'qb-core');
    expect(detectFramework()).toBe('qb');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
  });

  it('drops a remembered adapter when its core stops', () => {
    const { running } = server({ qbx_core: { GetPlayer: () => null } });
    expect(detectFramework()).toBe('qb');

    delete running.qbx_core;
    running.es_extended = esxCore();
    fire('onResourceStop', 'qbx_core');

    expect(detectFramework()).toBe('esx');
    expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE);
  });

  it('keeps its answer when some other resource restarts', () => {
    const { asked } = server({ 'qb-core': qbCore('CIT_A') });
    FrameworkBridge.getCitizenId(1);
    const settled = asked('qbx_core');

    fire('onResourceStart', 'ox_inventory');
    fire('onResourceStop', 'mica');
    FrameworkBridge.getCitizenId(1);

    expect(asked('qbx_core')).toBe(settled);
  });
});
