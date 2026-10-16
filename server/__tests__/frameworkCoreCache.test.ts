// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MICA-351: the qb-core and ESX core objects are fetched once, not per lookup.
 *
 * Across resources, `GetCoreObject()` and `getSharedObject()` are a msgpack copy of the whole
 * core — every connected player and the item catalog — and `getPlayer` runs on every net event.
 * These pin one fetch across many lookups, a fresh one after the core restarts, and that the
 * one data field read off the ESX object (`Players`) never comes from the held copy.
 *
 * The cache subscribes to `onResourceStart`/`onResourceStop` when `qb.ts` and `esx.ts` are
 * imported, so `on` is replaced with a recorder before any import, and every handler
 * registered for an event is fired — not only the last (see the agent memory on
 * single-slot handler capture).
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

import { FrameworkBridge, __setResourceLookup } from '../lib/FrameworkBridge';
import { __resetAssignedNumbers } from '../lib/phoneNumbers';

const fire = (event: string, ...args: unknown[]): void => {
  for (const handler of handlers.get(event) ?? []) handler(...args);
};

afterAll(() => {
  (globalThis as Record<string, unknown>).on = previousOn;
});

beforeEach(() => {
  __resetAssignedNumbers();
});
afterEach(() => __setResourceLookup());

/** qb-core with a live player table behind `GetPlayer`, counting every core fetch. */
const qbCore = () => {
  const online = new Map<number, unknown>();
  const GetCoreObject = vi.fn(() => ({
    Functions: {
      GetPlayer: (src: number) => online.get(src) ?? null,
      GetQBPlayers: () => Object.fromEntries(online)
    }
  }));
  __setResourceLookup((name) => (name === 'qb-core' ? { GetCoreObject } : undefined));
  const load = (src: number, citizenid: string) =>
    online.set(src, { PlayerData: { citizenid, charinfo: {} } });
  return { GetCoreObject, online, load };
};

describe('qb-core core object (MICA-351)', () => {
  it('is fetched once across many lookups, and its functions still read live state', () => {
    const { GetCoreObject, load, online } = qbCore();
    load(1, 'CIT_A');

    for (let i = 0; i < 50; i++) expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['1']);

    // A player loading and one leaving after the fetch are both seen through the held copy.
    load(2, 'CIT_B');
    online.delete(1);
    expect(FrameworkBridge.getCitizenId(2)).toBe('CIT_B');
    expect(FrameworkBridge.getCitizenId(1)).toBeNull();
    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['2']);

    expect(GetCoreObject).toHaveBeenCalledTimes(1);
  });

  for (const [event, arg] of [
    ['onResourceStart', 'qb-core'],
    ['onResourceStop', 'qb-core'],
    ['QBCore:Server:UpdateObject', undefined]
  ] as const) {
    it(`is fetched again after ${event}`, () => {
      const { GetCoreObject, load } = qbCore();
      load(1, 'CIT_A');

      FrameworkBridge.getCitizenId(1);
      FrameworkBridge.getCitizenId(1);
      expect(GetCoreObject).toHaveBeenCalledTimes(1);

      fire(event, arg);
      FrameworkBridge.getCitizenId(1);
      FrameworkBridge.getCitizenId(1);
      expect(GetCoreObject).toHaveBeenCalledTimes(2);
    });
  }

  it('is not dropped when some other resource restarts', () => {
    const { GetCoreObject, load } = qbCore();
    load(1, 'CIT_A');

    FrameworkBridge.getCitizenId(1);
    fire('onResourceStart', 'ox_inventory');
    fire('onResourceStop', 'es_extended');
    FrameworkBridge.getCitizenId(1);

    expect(GetCoreObject).toHaveBeenCalledTimes(1);
  });

  it('never holds an empty answer, so a core that was not ready is asked again', () => {
    const real = qbCore();
    real.load(1, 'CIT_A');
    const GetCoreObject = vi.fn().mockReturnValueOnce(undefined);
    GetCoreObject.mockImplementation(real.GetCoreObject);
    __setResourceLookup((name) => (name === 'qb-core' ? { GetCoreObject } : undefined));

    expect(FrameworkBridge.getCitizenId(1)).toBeNull();
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(GetCoreObject).toHaveBeenCalledTimes(2);
  });

  it('never holds a core fetched before it has its functions, so a mid-start fetch recovers', () => {
    const real = qbCore();
    real.load(1, 'CIT_A');
    const GetCoreObject = vi.fn().mockReturnValueOnce({ Functions: {} });
    GetCoreObject.mockImplementation(real.GetCoreObject);
    __setResourceLookup((name) => (name === 'qb-core' ? { GetCoreObject } : undefined));

    expect(FrameworkBridge.getCitizenId(1)).toBeNull();
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(GetCoreObject).toHaveBeenCalledTimes(2);
  });

  it('is dropped when the test seam swaps the lookup, so a suite never sees the last fake', () => {
    const first = qbCore();
    first.load(1, 'CIT_A');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');

    const second = qbCore();
    second.load(1, 'CIT_Z');
    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_Z');
  });
});

const LICENSE_A = 'license:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LICENSE_B = 'license:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const xPlayer = (identifier: string, source: number) => {
  const variables: Record<string, string> = { firstName: 'Ada', lastName: 'Lovelace' };
  return {
    identifier,
    source,
    variables,
    get: (key: string) => variables[key],
    getName: () => 'Ada Lovelace'
  };
};

describe('ESX shared object (MICA-351)', () => {
  const esx = (shared: () => Record<string, unknown>) => {
    const getSharedObject = vi.fn(shared);
    __setResourceLookup((name) => (name === 'es_extended' ? { getSharedObject } : undefined));
    return getSharedObject;
  };

  it('is fetched once across many lookups, and again after es_extended restarts', () => {
    const online = new Map<number, unknown>([[1, xPlayer(LICENSE_A, 1)]]);
    const getSharedObject = esx(() => ({
      GetPlayerFromId: (src: number) => online.get(src) ?? null,
      GetExtendedPlayers: () => [...online.values()]
    }));

    for (let i = 0; i < 50; i++) expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE_A);
    online.set(2, xPlayer(LICENSE_B, 2));
    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['1', '2']);
    const settled = getSharedObject.mock.calls.length;
    expect(settled).toBe(1);

    fire('onResourceStop', 'es_extended');
    FrameworkBridge.getCitizenId(1);
    fire('onResourceStart', 'es_extended');
    FrameworkBridge.getCitizenId(1);
    FrameworkBridge.getCitizenId(1);
    expect(getSharedObject).toHaveBeenCalledTimes(3);
  });

  it('never holds a shared object fetched before it has GetPlayerFromId', () => {
    // Held, the half-built object kept `canGetPlayer` false until es_extended next restarted;
    // the per-call fetch it replaced recovered on the next request (MICA-351 review).
    const online = new Map<number, unknown>([[1, xPlayer(LICENSE_A, 1)]]);
    let started = false;
    const getSharedObject = esx(() =>
      started
        ? {
            GetPlayerFromId: (src: number) => online.get(src) ?? null,
            GetExtendedPlayers: () => [...online.values()]
          }
        : { GetExtendedPlayers: () => [] }
    );

    expect(FrameworkBridge.getCitizenId(1)).toBeNull();
    const beforeStart = getSharedObject.mock.calls.length;

    started = true;
    expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE_A);
    const settled = getSharedObject.mock.calls.length;
    for (let i = 0; i < 20; i++) expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE_A);

    expect(settled).toBeGreaterThan(beforeStart);
    expect(getSharedObject).toHaveBeenCalledTimes(settled);
  });

  it('reads ESX.Players afresh, never off the held copy', () => {
    // The data field is copied with the object, so a held copy would list a player who has
    // left — on a server id FiveM may already have handed to somebody else.
    const online: Record<number, unknown> = { 5: xPlayer(LICENSE_A, 5) };
    esx(() => ({ Players: { ...online }, GetPlayerFromId: () => null }));

    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['5']);

    delete online[5];
    online[9] = xPlayer(LICENSE_B, 9);
    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['9']);
  });
});
