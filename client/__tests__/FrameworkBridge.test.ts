// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client framework bridge's lookups (MICA-355): each framework's core object is fetched
 * once rather than per call, a framework that is not running is never touched through
 * `exports`, and a restart refreshes what was cached.
 *
 * `exports` here is a Proxy that throws on a resource it does not know, the way FiveM's does —
 * a plain object answering `undefined` would hide exactly the probe cost this ticket removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Bridge = typeof import('../lib/FrameworkBridge').FrameworkBridge;

const g = globalThis as Record<string, unknown>;
const saved = { exports: g.exports, GetResourceState: g.GetResourceState, emit: g.emit, on: g.on };

let resources: Record<string, unknown>;
let states: Record<string, string>;
let touched: string[];
let handlers: Map<string, Array<(...args: unknown[]) => void>>;

/** Fire a local event the bridge subscribed with `on`, as FiveM would. */
const fire = (event: string, ...args: unknown[]) => {
  for (const handler of handlers.get(event) ?? []) handler(...args);
};

const installExports = () => {
  g.exports = new Proxy(
    {},
    {
      get(_target, name) {
        touched.push(String(name));
        if (!(String(name) in resources))
          throw new Error(`No such export resource ${String(name)}`);
        return resources[String(name)];
      }
    }
  );
};

const loadBridge = async (): Promise<Bridge> => {
  vi.resetModules();
  return (await import('../lib/FrameworkBridge')).FrameworkBridge;
};

/** A qb core whose `GetPlayerData` reads live state, as a funcref into qb-core would. */
const qbCore = (live: { data: any }) => ({
  Shared: { Items: {} },
  Functions: { GetPlayerData: vi.fn(() => live.data) }
});

beforeEach(() => {
  resources = {};
  states = {};
  touched = [];
  handlers = new Map();
  installExports();
  g.on = (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  };
  g.GetResourceState = (name: string) => states[name] ?? 'missing';
  g.emit = vi.fn();
});

afterEach(() => {
  Object.assign(g, saved);
  vi.restoreAllMocks();
});

describe('qb-core', () => {
  it('fetches the core object once and still answers the current character', async () => {
    const live = { data: { citizenid: 'ABC123', charinfo: { phone: '5550101' } } };
    const core = qbCore(live);
    const GetCoreObject = vi.fn(() => core);
    resources['qb-core'] = { GetCoreObject };
    states['qb-core'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).toBe('ABC123');
    live.data = { citizenid: 'XYZ789', charinfo: { phone: '5550202' } };
    expect(bridge.getCitizenId()).toBe('XYZ789');
    expect(bridge.getPhoneNumber()).toBe('5550202');

    expect(GetCoreObject).toHaveBeenCalledTimes(1);
    expect(core.Functions.GetPlayerData).toHaveBeenCalledTimes(3);
  });

  it('never touches exports for qbx_core when qbx_core is not running', async () => {
    resources['qb-core'] = { GetCoreObject: () => qbCore({ data: { citizenid: 'ABC123' } }) };
    states['qb-core'] = 'started';
    const bridge = await loadBridge();

    bridge.getCitizenId();
    bridge.getBankBalance();

    expect(touched).not.toContain('qbx_core');
  });

  it('refetches the core object when a cached funcref throws after a restart', async () => {
    const stale = {
      Functions: {
        GetPlayerData: vi.fn(() => ({ citizenid: 'OLD' }))
      }
    };
    const fresh = qbCore({ data: { citizenid: 'NEW' } });
    const GetCoreObject = vi.fn().mockReturnValueOnce(stale).mockReturnValue(fresh);
    resources['qb-core'] = { GetCoreObject };
    states['qb-core'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).toBe('OLD');
    stale.Functions.GetPlayerData.mockImplementation(() => {
      throw new Error('funcref to a stopped resource');
    });

    expect(bridge.getCitizenId()).toBe('NEW');
    expect(bridge.getCitizenId()).toBe('NEW');
    expect(GetCoreObject).toHaveBeenCalledTimes(2);
  });

  it('refetches after a resource start, even when the stale funcref answers nil', async () => {
    const stale = { Functions: { GetPlayerData: vi.fn(() => ({ citizenid: 'OLD' })) } };
    const fresh = qbCore({ data: { citizenid: 'NEW' } });
    const GetCoreObject = vi.fn().mockReturnValueOnce(stale).mockReturnValue(fresh);
    resources['qb-core'] = { GetCoreObject };
    states['qb-core'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).toBe('OLD');
    // A restart that left the old funcref answering nil instead of throwing.
    stale.Functions.GetPlayerData.mockReturnValue(undefined as never);
    expect(bridge.getCitizenId()).toBeNull();

    fire('onClientResourceStart', 'qb-core');
    expect(bridge.getCitizenId()).toBe('NEW');
    expect(GetCoreObject).toHaveBeenCalledTimes(2);
  });

  it('drops both cached cores on any resource stop, forks included', async () => {
    const GetCoreObject = vi.fn(() => qbCore({ data: { citizenid: 'ABC123' } }));
    const getSharedObject = vi.fn(() => ({ GetPlayerData: () => null }));
    resources['qb-core'] = { GetCoreObject };
    resources['es_extended'] = { getSharedObject };
    states['qb-core'] = 'started';
    states['es_extended'] = 'started';
    const bridge = await loadBridge();

    bridge.getCitizenId();
    fire('onClientResourceStop', 'my-qb-fork');
    bridge.getCitizenId();
    expect(GetCoreObject).toHaveBeenCalledTimes(2);

    // ESX is reached once qb-core answers no player.
    delete resources['qb-core'];
    states['qb-core'] = 'missing';
    bridge.getCitizenId();
    bridge.getCitizenId();
    expect(getSharedObject).toHaveBeenCalledTimes(1);
    fire('onClientResourceStart', 'my-esx-fork');
    bridge.getCitizenId();
    expect(getSharedObject).toHaveBeenCalledTimes(2);
  });

  it('falls through to ESX when the qb lookup throws', async () => {
    resources['qb-core'] = {
      GetCoreObject: () => {
        throw new Error('broken core');
      }
    };
    resources['es_extended'] = {
      getSharedObject: () => ({ GetPlayerData: () => ({ identifier: 'char1:abc123' }) })
    };
    states['qb-core'] = 'started';
    states['es_extended'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).not.toBeNull();
  });
});

describe('qbx_core', () => {
  it('answers through the export when qbx_core is running', async () => {
    resources['qbx_core'] = {
      GetPlayerData: () => ({ citizenid: 'QBX1', money: { bank: 12 } }),
      GetMoney: () => 40
    };
    states['qbx_core'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).toBe('QBX1');
    expect(bridge.getBankBalance()).toBe(40);
  });
});

describe('es_extended', () => {
  it('fetches a Legacy shared object once and reads live data through it', async () => {
    const live = { data: { identifier: 'char1:abc123', accounts: [{ name: 'bank', money: 5 }] } };
    const getSharedObject = vi.fn(() => ({ GetPlayerData: () => live.data }));
    resources['es_extended'] = { getSharedObject };
    states['es_extended'] = 'started';
    const bridge = await loadBridge();

    expect(bridge.getBankBalance()).toBe(5);
    live.data = { ...live.data, accounts: [{ name: 'bank', money: 9 }] };
    expect(bridge.getBankBalance()).toBe(9);

    expect(getSharedObject).toHaveBeenCalledTimes(1);
    expect(touched).not.toContain('qbx_core');
    expect(touched).not.toContain('qb-core');
  });

  it('never waits on the pre-Legacy event when the export is absent, and says why', async () => {
    // FiveM's per-resource proxy throws on an export the resource does not register.
    resources['es_extended'] = new Proxy(
      {},
      {
        get(_target, name) {
          throw new Error(`No such export ${String(name)} in resource es_extended`);
        }
      }
    );
    states['es_extended'] = 'started';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = await loadBridge();

    expect(bridge.getPlayerData()).toBeNull();
    expect(bridge.getBankBalance()).toBe(0);
    expect(g.emit).not.toHaveBeenCalled();
    // Once per session, naming the cause, however often the UI polls.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/getSharedObject.*ESX Legacy/);
  });

  it('treats a shared object without GetPlayerData as not ready: silent, unheld, refetched', async () => {
    // Never read through a `PlayerData` snapshot, and not refused either — the server reads
    // this shape as a shared object that is not ready yet (MICA-421).
    let ready = false;
    const getSharedObject = vi.fn(() =>
      ready
        ? {
            GetPlayerData: () => ({
              identifier: 'char1:abc123',
              accounts: [{ name: 'bank', money: 9 }]
            })
          }
        : { PlayerData: { identifier: 'char1:abc123', accounts: [{ name: 'bank', money: 5 }] } }
    );
    resources['es_extended'] = { getSharedObject };
    states['es_extended'] = 'started';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = await loadBridge();

    expect(bridge.getBankBalance()).toBe(0);
    expect(bridge.getCitizenId()).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(g.emit).not.toHaveBeenCalled();

    ready = true;
    expect(bridge.getBankBalance()).toBe(9);
    expect(bridge.getBankBalance()).toBe(9);
    // Twice while not ready, once more when ready, and held from then on.
    expect(getSharedObject).toHaveBeenCalledTimes(3);
  });

  it('says a refusal again after a resource restart, which may be Legacy being installed', async () => {
    resources['es_extended'] = {};
    states['es_extended'] = 'started';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = await loadBridge();

    bridge.getPlayerData();
    bridge.getPlayerData();
    expect(error).toHaveBeenCalledTimes(1);

    fire('onClientResourceStart', 'es_extended');
    bridge.getPlayerData();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('probes every framework when no state reads started (a provided fork)', async () => {
    // A fork that `provide`s qb-core under its own resource name: every state reads 'missing'.
    resources['qb-core'] = { GetCoreObject: () => qbCore({ data: { citizenid: 'FORK1' } }) };
    const bridge = await loadBridge();

    expect(bridge.getCitizenId()).toBe('FORK1');
    expect(touched).toContain('qbx_core');
  });

  it('answers null and 0 on a standalone server with no framework at all', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = await loadBridge();

    expect(bridge.getPlayerData()).toBeNull();
    expect(bridge.getBankBalance()).toBe(0);
    // No framework is not a broken framework: nothing to complain about, nothing to wait on.
    expect(error).not.toHaveBeenCalled();
    expect(g.emit).not.toHaveBeenCalled();
  });
});
