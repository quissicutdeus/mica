// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  insert: vi.fn(),
  update: vi.fn(),
  scalar: vi.fn(async () => null),
  single: vi.fn(async () => null)
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  FrameworkBridge,
  detectFramework,
  STANDALONE_CONVAR,
  __setResourceLookup,
  __resetStandaloneWarnings
} from '../lib/FrameworkBridge';
import { esxAdapter } from '../lib/framework/esx';
import { qbAdapter } from '../lib/framework/qb';
import { qbxAdapter } from '../lib/framework/qbx';
import { standaloneAdapter } from '../lib/framework/standalone';

/**
 * MICA-197 split `FrameworkBridge` into one adapter per framework. `FrameworkBridge.test.ts`
 * and `standaloneBridge.test.ts` already cover what each framework *answers*; what is new, and
 * what nothing else looks at, is **how one gets chosen**.
 *
 * The thing worth pinning is that selection happens per method rather than per server. The
 * chains this replaced probed a different export before each call — `qbx_core.GetPlayer` for
 * one, `qbx_core.GetQBPlayers` for another, `qbx_core.CreateUseableItem` for a third — because
 * a FiveM resource exposes each of its exports independently. Collapsing that into one
 * "which framework is this" probe is the obvious simplification and is wrong: a build offering
 * one export and not another has to keep falling through to the next core.
 */

const useResources = (map: Record<string, unknown>) =>
  __setResourceLookup((name) => (map as Record<string, any>)[name]);

/** The convar the standalone adapter is the only one that reads. */
const convar = { value: '' };

beforeEach(() => {
  vi.clearAllMocks();
  convar.value = '';
  __resetStandaloneWarnings();
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === STANDALONE_CONVAR ? convar.value : fallback;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('the adapters, as a set', () => {
  /**
   * `detectFramework` answers `'qb'` for qbx_core and qb-core alike, because they keep
   * characters in the same table under the same column — which is the whole reason `qbx.ts`
   * imports its offline lookups and its owner table from `qb.ts` rather than restating them.
   */
  it('answers one kind per framework, with both qb cores sharing theirs', () => {
    expect(qbxAdapter.kind).toBe('qb');
    expect(qbAdapter.kind).toBe('qb');
    expect(esxAdapter.kind).toBe('esx');
    expect(standaloneAdapter.kind).toBe('standalone');
  });

  it('points both qb cores at the same owner table', () => {
    expect(qbxAdapter.ownerTable()).toEqual({ table: 'players', column: 'citizenid' });
    expect(qbAdapter.ownerTable()).toEqual(qbxAdapter.ownerTable());
    expect(esxAdapter.ownerTable()).toEqual({ table: 'users', column: 'identifier' });
    // Standalone has no character table at all — micaOS is the only record a player has.
    expect(standaloneAdapter.ownerTable()).toBeNull();
  });
});

/**
 * The order is a compatibility decision rather than a preference: a live server does not
 * change which string it calls a citizenid on the strength of a second resource being
 * installed, because every micaOS row is keyed on the one it already uses.
 */
describe('which framework wins when more than one answers', () => {
  it('prefers a qb core over es_extended', () => {
    useResources({
      qbx_core: { GetPlayer: () => null },
      es_extended: { getSharedObject: () => ({}) }
    });

    expect(detectFramework()).toBe('qb');
    expect(FrameworkBridge.ownerTable()).toEqual({ table: 'players', column: 'citizenid' });
  });

  it('prefers qbx_core over qb-core', () => {
    const qbxGetPlayer = vi.fn(() => null);
    const qbGetCoreObject = vi.fn(() => ({ Functions: { GetPlayer: () => null } }));
    useResources({
      qbx_core: { GetPlayer: qbxGetPlayer },
      'qb-core': { GetCoreObject: qbGetCoreObject }
    });

    FrameworkBridge.getPlayer(5);

    expect(qbxGetPlayer).toHaveBeenCalled();
    // Committed to, not fallen through: a qbx player who is simply not loaded is not then
    // looked for in qb-core.
    expect(qbGetCoreObject).not.toHaveBeenCalled();
  });

  it('is unknown when nothing answers, and never standalone by default', () => {
    useResources({});
    expect(detectFramework()).toBe('unknown');
  });

  /**
   * The convar beside a running framework is a misconfiguration, and the framework wins —
   * preferring standalone would re-key every existing row from a citizenid onto a license
   * identifier, which is a data migration performed by a typo.
   */
  it('keeps the framework when the standalone convar is set alongside one', () => {
    convar.value = '1';
    useResources({ qbx_core: { GetPlayer: () => null } });

    expect(detectFramework()).toBe('qb');
  });

  it('is standalone only when the operator asked and nothing else answered', () => {
    convar.value = '1';
    useResources({});

    expect(detectFramework()).toBe('standalone');
  });
});

/**
 * The heart of it. Each of these gives qbx **one** of its three exports and checks that the
 * call it cannot serve reaches the next adapter rather than dying on it.
 */
describe('selection is per method, not per server', () => {
  it('lists players through a qbx build that exposes only GetQBPlayers', () => {
    const online = { 5: { PlayerData: { citizenid: 'CIT_A' } } };
    useResources({ qbx_core: { GetQBPlayers: () => online } });

    // No `GetPlayer`, so `detectFramework` cannot see qbx at all...
    expect(detectFramework()).toBe('unknown');
    // ...and the listing still works, because that is a different export.
    expect(FrameworkBridge.getAllPlayers()).toEqual(online);
  });

  it('answers for a loaded player through a qbx build that exposes only GetPlayer', () => {
    useResources({
      qbx_core: { GetPlayer: () => ({ PlayerData: { citizenid: 'CIT_A' } }) }
    });

    expect(FrameworkBridge.getPlayer(5)?.citizenid).toBe('CIT_A');
    // `GetQBPlayers` is absent, so the listing finds nobody rather than throwing.
    expect(FrameworkBridge.getAllPlayers()).toEqual({});
  });

  /**
   * The bug this shape exists to prevent, and one the suite caught: a qb adapter that reached
   * for `GetCoreObject` without probing for it first threw on every non-qb server, the bridge's
   * own `try` swallowed it, and the walk stopped — so ESX and standalone silently registered
   * nothing at all.
   */
  it('reaches the ESX registrar on a server with no qb core present', () => {
    const RegisterUsableItem = vi.fn();
    useResources({ es_extended: { getSharedObject: () => ({ RegisterUsableItem }) } });

    const cb = vi.fn();
    FrameworkBridge.registerUsableItem('battery_bank', cb);

    expect(RegisterUsableItem).toHaveBeenCalledWith('battery_bank', cb);
  });

  it('reaches the standalone registrar past every framework adapter', () => {
    convar.value = '1';
    const RegisterUsableItem = vi.fn();
    useResources({ ox_inventory: { RegisterUsableItem } });

    const cb = vi.fn();
    FrameworkBridge.registerUsableItem('phone', cb);

    expect(RegisterUsableItem).toHaveBeenCalledWith('phone', cb);
  });

  /**
   * Standalone is asked last **and only when it is the verdict**. With a framework running,
   * the convar being set must not let it claim a call the framework could not serve — that
   * would be the re-keying the conflict rule refuses, arriving by a side door.
   */
  it('does not let a set convar serve a call while a framework is running', () => {
    convar.value = '1';
    const oxRegister = vi.fn();
    useResources({
      // A qbx core that answers for a player but has no usable-item registrar at all.
      qbx_core: { GetPlayer: () => ({ PlayerData: { citizenid: 'CIT_A' } }) },
      ox_inventory: { RegisterUsableItem: oxRegister }
    });

    FrameworkBridge.registerUsableItem('phone', vi.fn());

    // Standalone would have registered it through ox_inventory. It is not the verdict here.
    expect(oxRegister).not.toHaveBeenCalled();
  });
});

/**
 * `unknown` falls through to the qb lookups for a *read*, which is what the branch chain this
 * replaced did — running the `players` query on a box that has no such table degrades to "no
 * name" and says so once. Only the destructive caller distinguishes the third state, and that
 * one asks `ownerTable`, which stays null.
 */
describe('offline reads when no framework has answered yet', () => {
  it('asks the qb players table, and still reports no owner table', async () => {
    useResources({});

    await FrameworkBridge.findOfflineByCitizenId('CIT_A');

    expect(String(dbMock.single.mock.calls[0][0])).toContain('players');
    expect(FrameworkBridge.ownerTable()).toBeNull();
  });

  it('asks the es_extended users table once es_extended is answering', async () => {
    useResources({ es_extended: { getSharedObject: () => ({}) } });

    await FrameworkBridge.findOfflineByCitizenIds(['CIT_A', 'CIT_B']);

    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('FROM users');
    expect(sql).toContain('identifier IN (?, ?)');
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 'CIT_B']);
  });

  it('asks nothing at all for an empty list', async () => {
    useResources({});

    expect(await FrameworkBridge.findOfflineByCitizenIds([])).toEqual(new Map());
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});
