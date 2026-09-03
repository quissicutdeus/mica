// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-151: gOS with no framework resource at all.
 *
 * The whole feature turns on one line — `ServiceEndpoint` answers "Player not authenticated"
 * to every action of every service when `FrameworkBridge.getPlayer` returns null, so a server
 * with no framework has an inert phone. Making `getPlayer` answer unblocks all of it at once,
 * which is also what makes the *refusals* below worth testing: an adapter that answers
 * cheerfully about money it does not have is worse than one that never answered at all.
 *
 * None of this is provable without a real FiveM server. What is provable here is the shape of
 * every answer, which is what the rest of the resource reads.
 *
 * `FrameworkBridge` imports `Database` for the offline lookups, and `Database` reads
 * `exports.oxmysql` in module scope, so it is mocked (AGENTS.md §1).
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  FrameworkBridge,
  detectFramework,
  STANDALONE_CONVAR,
  __setResourceLookup,
  __resetStandaloneWarnings,
  __resetOfflineLookupWarnings
} from '../lib/FrameworkBridge';
import { __resetAssignedNumbers, rememberNumber } from '../lib/phoneNumbers';

/** A well-formed FiveM license: the 40 hex characters every client has one of. */
const LICENSE = `license:${'a'.repeat(40)}`;
const OTHER_LICENSE = `license:${'b'.repeat(40)}`;

const useResources = (map: Record<string, unknown>) =>
  __setResourceLookup((name) => (map as Record<string, any>)[name]);

const qbx = (player: unknown) => ({ qbx_core: { GetPlayer: () => player } });
const esx = (shared: unknown) => ({ es_extended: { getSharedObject: () => shared } });

/** The convar, as an operator would set it. `undefined` means they never touched it. */
const setConvar = (value?: string) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === STANDALONE_CONVAR && value !== undefined ? value : fallback;
};

/**
 * The FiveM identity natives, as a connected player would answer them.
 *
 * Keyed by source so a test can describe a whole server rather than one player — which is
 * what `getAllPlayers` needs, and what makes "never list a player you cannot name" testable.
 */
interface FakePlayer {
  license?: string;
  /** Identifiers as the numbered-native fallback sees them, when `license` is not set. */
  identifiers?: string[];
  name?: string;
}

const connect = (players: Record<number, FakePlayer>) => {
  const sources = Object.keys(players).map(Number);

  (globalThis as any).GetPlayerIdentifierByType = (src: string, type: string) =>
    type === 'license' ? (players[Number(src)]?.license ?? '') : '';
  (globalThis as any).GetNumPlayerIdentifiers = (src: string) =>
    players[Number(src)]?.identifiers?.length ?? 0;
  (globalThis as any).GetPlayerIdentifier = (src: string, index: number) =>
    players[Number(src)]?.identifiers?.[index] ?? '';
  (globalThis as any).GetPlayerName = (src: string) => players[Number(src)]?.name ?? '';
  (globalThis as any).GetNumPlayerIndices = () => sources.length;
  (globalThis as any).GetPlayerFromIndex = (index: number) => String(sources[index]);
};

/** No identity natives at all — an FXServer build older than any of them. */
const noNatives = () => {
  for (const native of [
    'GetPlayerIdentifierByType',
    'GetNumPlayerIdentifiers',
    'GetPlayerIdentifier',
    'GetPlayerName',
    'GetNumPlayerIndices',
    'GetPlayerFromIndex'
  ]) {
    delete (globalThis as any)[native];
  }
};

const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
const errors = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetStandaloneWarnings();
  __resetOfflineLookupWarnings();
  __resetAssignedNumbers();
  useResources({});
  setConvar('1');
  connect({ 5: { license: LICENSE, name: 'Ada Lovelace' } });
});

afterEach(() => {
  __setResourceLookup();
  noNatives();
  setConvar(undefined);
});

describe('detectFramework and the standalone opt-in', () => {
  it('answers standalone only when the operator asked for it', () => {
    expect(detectFramework()).toBe('standalone');
  });

  it('still answers unknown with no framework and no convar', () => {
    // The property MICA-150 established and this ticket must not disturb: absence of a
    // framework is *not* evidence of standalone, because `exposes` cannot tell a missing
    // resource from one that has not started yet.
    setConvar(undefined);
    expect(detectFramework()).toBe('unknown');
  });

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['  TRUE  ', true],
    ['0', false],
    ['false', false],
    ['', false]
  ])('reads %j as %s', (value, expected) => {
    setConvar(value);
    expect(detectFramework() === 'standalone').toBe(expected);
  });

  it('reads an unparseable value as off, and says so once', () => {
    // `GetConvar` is a free-form string with no validation of its own. An operator who typed
    // something it cannot read meant to enable this and has not, and the difference between
    // that and a working phone is one line they can act on.
    setConvar('yes-please');

    for (let i = 0; i < 5; i++) expect(detectFramework()).toBe('unknown');

    expect(warnings().filter((line) => line.includes(STANDALONE_CONVAR))).toHaveLength(1);
    expect(warnings()[0]).toContain('yes-please');
  });

  it('keeps qb when the convar is set and a qb core is running, and says so loudly', () => {
    // The misconfiguration case. Preferring standalone would re-key every existing row from
    // a citizenid onto a license identifier — a data migration performed by a typo.
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A' } }));

    expect(detectFramework()).toBe('qb');
    expect(errors().filter((line) => line.includes(STANDALONE_CONVAR))).toHaveLength(1);
    expect(errors()[0]).toContain('qb');
  });

  it('keeps ESX the same way', () => {
    useResources(esx({ GetPlayerFromId: () => null }));

    expect(detectFramework()).toBe('esx');
    expect(errors()[0]).toContain(STANDALONE_CONVAR);
  });

  it('says the conflict once per resource start, not once per request', () => {
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A' } }));

    for (let i = 0; i < 20; i++) detectFramework();

    expect(errors().filter((line) => line.includes(STANDALONE_CONVAR))).toHaveLength(1);
  });

  it('serves the real framework rather than standalone when both are present', () => {
    // Not just the verdict — the player actually returned has to be the framework's.
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A', charinfo: { phone: '5551000' } } }));

    expect(FrameworkBridge.getCitizenId(5)).toBe('CIT_A');
  });
});

describe('the standalone player', () => {
  it('keys the phone on the license identifier', () => {
    expect(FrameworkBridge.getCitizenId(5)).toBe(LICENSE);
  });

  it('falls back to scanning the numbered identifiers when the typed native is absent', () => {
    // An FXServer build without `GetPlayerIdentifierByType`. Picking one route and being
    // wrong renders every player unidentifiable, silently.
    connect({ 5: { identifiers: ['steam:110000100000000', 'ip:127.0.0.1', LICENSE] } });
    delete (globalThis as any).GetPlayerIdentifierByType;

    expect(FrameworkBridge.getCitizenId(5)).toBe(LICENSE);
  });

  it('takes the license and never another identifier type', () => {
    // steam is absent for anyone not on Steam, ip changes, discord can be revoked — any of
    // them as the key hands a returning player a fresh, empty phone.
    connect({ 5: { identifiers: ['steam:110000100000000', 'discord:1234'] } });
    delete (globalThis as any).GetPlayerIdentifierByType;

    expect(FrameworkBridge.getPlayer(5)).toBeNull();
  });

  it('refuses to invent an identity when there is no license at all', () => {
    connect({ 5: { name: 'Ada' } });

    expect(FrameworkBridge.getPlayer(5)).toBeNull();
    expect(errors().some((line) => line.includes('standalone'))).toBe(true);
  });

  it('refuses an over-length identifier rather than truncating it', () => {
    // `shared/framework.ts` explains why at length: a truncated citizenid is still
    // self-consistent inside gOS and joins to nothing outside it, which is what makes the
    // orphan sweep read the player's rows as unowned.
    connect({ 5: { license: `license:${'a'.repeat(60)}` } });

    expect(FrameworkBridge.getPlayer(5)).toBeNull();
    expect(errors().some((line) => line.includes('characters'))).toBe(true);
  });

  it('is null when nobody is connected on that source', () => {
    expect(FrameworkBridge.getPlayer(999)).toBeNull();
  });

  it('survives an FXServer build with none of the identity natives', () => {
    noNatives();
    expect(() => FrameworkBridge.getPlayer(5)).not.toThrow();
    expect(FrameworkBridge.getPlayer(5)).toBeNull();
  });
});

describe('the qb shape everything downstream reads', () => {
  it('renders the client name as a first and last name', () => {
    // `PlayerDirectory`, `Messages` and `Music` all read `PlayerData.charinfo.firstname`.
    const player = FrameworkBridge.getPlayer(5);

    expect(player?.rawPlayer.PlayerData).toMatchObject({
      citizenid: LICENSE,
      source: 5,
      charinfo: { firstname: 'Ada', lastname: 'Lovelace' }
    });
  });

  it('renders a single-word name as a first name', () => {
    connect({ 5: { license: LICENSE, name: 'Ada' } });

    expect(FrameworkBridge.getPlayer(5)?.rawPlayer.PlayerData.charinfo).toMatchObject({
      firstname: 'Ada',
      lastname: ''
    });
  });

  it('leaves both blank rather than inventing a name', () => {
    connect({ 5: { license: LICENSE } });

    expect(FrameworkBridge.getPlayer(5)?.rawPlayer.PlayerData.charinfo).toMatchObject({
      firstname: '',
      lastname: ''
    });
  });

  it('carries the number gOS issued, on the player and in the qb view', () => {
    // `getPlayer` is synchronous and the number lives in a table, so the cache in
    // `lib/phoneNumbers.ts` is what bridges them. `getPlayerByPhone` walks this same view.
    rememberNumber(LICENSE, '5561234');

    const player = FrameworkBridge.getPlayer(5);

    expect(player?.phone).toBe('5561234');
    expect(player?.rawPlayer.PlayerData.charinfo.phone).toBe('5561234');
    expect(FrameworkBridge.getPlayerPhone(5)).toBe('5561234');
  });

  it('has no number until one has been assigned, rather than inventing one', () => {
    const player = FrameworkBridge.getPlayer(5);

    expect(player?.phone).toBeUndefined();
    expect(player?.rawPlayer.PlayerData.charinfo.phone).toBeNull();
  });

  it('finds a connected player by the number they were issued', () => {
    connect({
      1: { license: LICENSE, name: 'Ada Lovelace' },
      7: { license: OTHER_LICENSE, name: 'Grace Hopper' }
    });
    rememberNumber(OTHER_LICENSE, '5561234');

    expect(FrameworkBridge.getPlayerByPhone('5561234')?.citizenid).toBe(OTHER_LICENSE);
  });
});

describe('standalone money fails closed', () => {
  it('reports every balance as unaffordable', () => {
    // `-Infinity` rather than 0: every caller asks `balance < amount`, and the sentinel has
    // to make that true for any amount, including a zero-cost one.
    const player = FrameworkBridge.getPlayer(5);

    expect(player?.getMoney('bank')).toBe(-Infinity);
    expect(player?.getMoney('cash')).toBe(-Infinity);
    expect(player!.getMoney('bank') < 0).toBe(true);
  });

  it('never reports a transfer as completed, in either direction', () => {
    // Fail-open on `addMoney` invents currency, which is the one error no later correction
    // fixes. Fail-open on `removeMoney` lets `Payments` credit a payee for a debit that
    // never happened, which is the same thing one step round.
    const player = FrameworkBridge.getPlayer(5);

    expect(player?.removeMoney('bank', 100)).toBe(false);
    expect(player?.addMoney('bank', 100)).toBe(false);
    expect(player?.removeMoney('cash', 0)).toBe(false);
  });

  it('says there is no money once per resource start, not once per call', () => {
    const player = FrameworkBridge.getPlayer(5);

    for (let i = 0; i < 20; i++) {
      player?.getMoney('bank');
      player?.removeMoney('bank', 1);
      player?.addMoney('bank', 1);
    }

    expect(warnings().filter((line) => line.includes('no money'))).toHaveLength(1);
  });
});

describe('standalone metadata degrades and says so', () => {
  it('drops the write without throwing', () => {
    const player = FrameworkBridge.getPlayer(5);

    expect(() => player?.setMeta('gos_battery', 42)).not.toThrow();
  });

  it('reports it once per resource start, because it is a property of the server', () => {
    // A `Set<number>` would grow for the life of the resource and, because FiveM recycles
    // server ids, silence a recycled id for whoever is assigned it next.
    const player = FrameworkBridge.getPlayer(5);
    const other = FrameworkBridge.getPlayer(5);

    for (let i = 0; i < 10; i++) player?.setMeta('gos_battery', i);
    other?.setMeta('gos_battery', 1);

    expect(warnings().filter((line) => line.includes('mirror metadata'))).toHaveLength(1);
  });

  it('names the key that was dropped, so the log is actionable', () => {
    FrameworkBridge.getPlayer(5)?.setMeta('gos_battery', 42);

    expect(warnings()[0]).toContain('gos_battery');
  });
});

describe('listing standalone players', () => {
  it('keys every connected player by source, in the qb shape', () => {
    connect({
      1: { license: LICENSE, name: 'Ada Lovelace' },
      7: { license: OTHER_LICENSE, name: 'Grace Hopper' }
    });

    const players = FrameworkBridge.getAllPlayers() as Record<number, any>;

    expect(Object.keys(players)).toEqual(['1', '7']);
    expect(players[7].PlayerData.citizenid).toBe(OTHER_LICENSE);
    expect(players[7].PlayerData.charinfo.firstname).toBe('Grace');
  });

  it('never lists a player it cannot name', () => {
    // A nameless entry here reaches `proximity` and `pushMany` as a real recipient — it
    // would be somebody else's mail.
    connect({
      1: { license: LICENSE, name: 'Ada Lovelace' },
      7: { name: 'No License' }
    });

    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['1']);
  });

  it('resolves a source from a citizenid through the same snapshot', () => {
    connect({
      1: { license: LICENSE, name: 'Ada Lovelace' },
      7: { license: OTHER_LICENSE, name: 'Grace Hopper' }
    });

    expect(FrameworkBridge.getSourceByCitizenId(OTHER_LICENSE)).toBe(7);
  });

  it('is empty rather than broken when the enumeration natives are absent', () => {
    noNatives();
    expect(FrameworkBridge.getAllPlayers()).toEqual({});
  });
});

describe('the owner table, which decides what the orphan sweep may delete', () => {
  it('is null on standalone, so the sweep skips', () => {
    // There is no framework character table to compare a citizenid against. A wrong answer
    // here — a leftover `players` from a previous install, say — reads every gOS row as
    // unowned and deletes the whole database at boot, with a log line saying it worked.
    expect(FrameworkBridge.ownerTable()).toBeNull();
  });

  it('is still qb-shaped when a qb core is present, convar or not', () => {
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A' } }));

    expect(FrameworkBridge.ownerTable()).toEqual({ table: 'players', column: 'citizenid' });
  });
});

describe('offline lookups on standalone', () => {
  it('never queries the `players` table, which does not exist here', async () => {
    // Falling through to the qb query is only harmless where that table might exist. Here it
    // certainly does not, and `offlineLookup` would swallow the failure into a once-per-start
    // warning about a broken table that was never supposed to be there.
    dbMock.single.mockResolvedValue(null);

    await FrameworkBridge.findOfflineByCitizenId(LICENSE);
    await FrameworkBridge.findOfflineByPhone('5550101');

    const queried = dbMock.single.mock.calls.map((call) => String(call[0]));
    expect(queried.some((query) => /\bplayers\b/.test(query))).toBe(false);
    expect(queried.every((query) => query.includes('gos_phone_numbers'))).toBe(true);
  });

  it('renders an offline player as the number gOS issued them', async () => {
    // gOS is the only record a standalone player has, so its own table is the framework
    // record. The name stays null on purpose: `GetPlayerName` answers only for a connected
    // client, and this lookup exists precisely for players who are not.
    dbMock.single.mockResolvedValue({ number: '5561234' });

    await expect(FrameworkBridge.findOfflineByCitizenId(LICENSE)).resolves.toEqual({
      citizenid: LICENSE,
      firstname: null,
      lastname: null,
      phone: '5561234'
    });
  });

  it('answers nothing for a citizenid it has never issued a number to', async () => {
    dbMock.single.mockResolvedValue(null);

    await expect(FrameworkBridge.findOfflineByCitizenId(LICENSE)).resolves.toBeNull();
  });

  it('resolves a number back to its owner, which no other framework can do', async () => {
    // This is what lets a standalone player dial, or start a conversation with, somebody who
    // is offline. ESX answers null here because core `users` has no phone column at all.
    dbMock.single.mockResolvedValue({ citizenid: OTHER_LICENSE });

    await expect(FrameworkBridge.findOfflineByPhone('5561234')).resolves.toEqual({
      citizenid: OTHER_LICENSE,
      firstname: null,
      lastname: null,
      phone: '5561234'
    });
  });

  it('answers nothing for a number nobody holds', async () => {
    dbMock.single.mockResolvedValue(null);

    await expect(FrameworkBridge.findOfflineByPhone('5561234')).resolves.toBeNull();
  });

  it('still queries `players` on a qb server', async () => {
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A' } }));
    dbMock.single.mockResolvedValue({ citizenid: 'CIT_A', charinfo: '{"firstname":"Ada"}' });

    await expect(FrameworkBridge.findOfflineByCitizenId('CIT_A')).resolves.toMatchObject({
      citizenid: 'CIT_A',
      firstname: 'Ada'
    });
  });
});

describe('items and usable items on standalone', () => {
  it('consumes an item through ox_inventory when it is installed', () => {
    const RemoveItem = vi.fn().mockReturnValue(true);
    useResources({ ox_inventory: { RemoveItem } });

    expect(FrameworkBridge.getPlayer(5)?.removeItem('phone', 1)).toBe(true);
    expect(RemoveItem).toHaveBeenCalledWith(5, 'phone', 1);
  });

  it('fails open with a warning when nothing can consume it', () => {
    // The stated policy for items, unchanged by there being no framework: a consumable whose
    // effect has already happened is not worth refusing over, and a silent `true` is the lie.
    expect(FrameworkBridge.getPlayer(5)?.removeItem('phone', 1)).toBe(true);
    expect(warnings().some((line) => line.includes('not consumed'))).toBe(true);
  });

  it('registers a usable item with ox_inventory when it exposes one', () => {
    const RegisterUsableItem = vi.fn();
    useResources({ ox_inventory: { RegisterUsableItem } });
    const cb = vi.fn();

    FrameworkBridge.registerUsableItem('phone', cb);

    expect(RegisterUsableItem).toHaveBeenCalledWith('phone', cb);
  });

  it('says once what the operator loses when nothing can register one', () => {
    // Silence here is indistinguishable from a registration that succeeded, which is the
    // failure shape this repo cares most about.
    for (let i = 0; i < 5; i++) FrameworkBridge.registerUsableItem('phone', vi.fn());

    const said = warnings().filter((line) => line.includes('usable-item registration'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('phone');
  });

  it('does not warn on a framework server, which has its own registrar', () => {
    const CreateUseableItem = vi.fn();
    useResources({ qbx_core: { GetPlayer: () => null, CreateUseableItem } });

    FrameworkBridge.registerUsableItem('phone', vi.fn());

    expect(CreateUseableItem).toHaveBeenCalled();
    expect(warnings().some((line) => line.includes('usable-item registration'))).toBe(false);
  });
});
