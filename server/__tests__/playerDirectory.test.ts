// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from 'vitest';

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

import { resolve, resolveByPhone } from '../lib/PlayerDirectory';
import { __setResourceLookup, __resetOfflineLookupWarnings } from '../lib/FrameworkBridge';

/**
 * One resolver for "who is this citizenid", online or off.
 *
 * There were two before, and they disagreed. `FrameworkBridge` had the online half;
 * `Conversations.ts` bypassed it with direct `exports[...]` calls, an inline name built from
 * `charinfo`, and its own `JSON_EXTRACT` fallback. Every social app needs this, and the one
 * that had it wrote it wrong — see the phone-number-as-citizenid case below.
 */

const charinfo = { firstname: 'Ada', lastname: 'Lovelace', phone: '555-0100' };

const onlinePlayer = (citizenid: string) => ({
  PlayerData: { citizenid, charinfo },
  Functions: {}
});

afterEach(() => {
  __setResourceLookup();
  vi.clearAllMocks();
});

describe('resolveByPhone', () => {
  it('prefers the loaded character over the database', async () => {
    // The framework's in-memory character is authoritative for a connected player: a rename
    // may not have been written back to `players` yet.
    __setResourceLookup((name) =>
      name === 'qbx_core'
        ? {
            GetPlayer: () => onlinePlayer('CIT_A'),
            GetQBPlayers: () => ({ 1: { PlayerData: { citizenid: 'CIT_A', charinfo } } })
          }
        : undefined
    );

    await expect(resolveByPhone('555-0100')).resolves.toEqual({
      citizenid: 'CIT_A',
      displayName: 'Ada Lovelace',
      phone: '555-0100'
    });
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('falls back to one SQL read when nobody is online with that number', async () => {
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce({ citizenid: 'CIT_OFFLINE', charinfo });

    await expect(resolveByPhone('555-0100')).resolves.toEqual({
      citizenid: 'CIT_OFFLINE',
      displayName: 'Ada Lovelace',
      phone: '555-0100'
    });
  });

  it('parses charinfo that arrives as a JSON string', async () => {
    // Driver- and column-type-dependent: some return the column as text, some as an object.
    // Both shapes reach here, so both are handled rather than one being assumed.
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce({
      citizenid: 'CIT_OFFLINE',
      charinfo: JSON.stringify(charinfo)
    });

    await expect(resolveByPhone('555-0100')).resolves.toMatchObject({
      displayName: 'Ada Lovelace'
    });
  });

  it('returns null for a number nobody holds, rather than inventing an identity', async () => {
    // The defect this replaces: the old code did `targetCitizenId = targetPlayer.phone_number`
    // when the framework returned an object with no PlayerData — putting a **phone number**
    // where a citizenid goes, into a column that is a foreign key onto `players`.
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce(null);

    await expect(resolveByPhone('555-9999')).resolves.toBeNull();
  });

  it('returns null for an empty number without touching the database', async () => {
    await expect(resolveByPhone('')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('reports no display name rather than a stray space when charinfo is absent', async () => {
    // `${first} ${last}` on two empty strings is " ", which would render as a blank name that
    // looks like a rendering bug rather than missing data.
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce({ citizenid: 'CIT_X', charinfo: null });

    await expect(resolveByPhone('555-0100')).resolves.toEqual({
      citizenid: 'CIT_X',
      displayName: null,
      phone: '555-0100'
    });
  });
});

describe('resolve', () => {
  it('resolves an online citizenid through the framework', async () => {
    __setResourceLookup((name) =>
      name === 'qbx_core'
        ? {
            GetPlayer: () => onlinePlayer('CIT_A'),
            GetQBPlayers: () => ({ 1: { PlayerData: { citizenid: 'CIT_A', charinfo } } })
          }
        : undefined
    );

    await expect(resolve('CIT_A')).resolves.toMatchObject({
      citizenid: 'CIT_A',
      displayName: 'Ada Lovelace'
    });
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('resolves an offline citizenid, which is what a feed needs', async () => {
    // A post outlives its author's session. Rendering it requires a name either way.
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce({ citizenid: 'CIT_GONE', charinfo });

    await expect(resolve('CIT_GONE')).resolves.toEqual({
      citizenid: 'CIT_GONE',
      displayName: 'Ada Lovelace',
      phone: '555-0100'
    });
  });

  it('returns null for a citizenid that does not exist', async () => {
    __setResourceLookup(() => undefined);
    dbMock.single.mockResolvedValueOnce(null);

    await expect(resolve('CIT_NOBODY')).resolves.toBeNull();
  });
});

/**
 * The same resolver on ESX (MICA-150).
 *
 * `PlayerDirectory` has no ESX branch and should not get one — both halves are framework
 * questions answered behind `FrameworkBridge`. Online, an `xPlayer` is normalised into the qb
 * shape, so `rawPlayer.PlayerData.charinfo` reads the same either way. Offline, the bridge
 * knows which table this server keeps players in: qb's `players(citizenid)` with its
 * `charinfo` JSON, or es_extended's own core `users(identifier)`.
 *
 * These exist to prove that rather than assume it, and to pin the one thing ESX genuinely
 * cannot do — resolve an offline player by phone number, which is not in core `users`.
 */
describe('on ESX', () => {
  const LICENSE = 'license:0123456789abcdef';

  const xPlayer = (identifier: string, source: number) => ({
    identifier,
    source,
    variables: { firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '555-0100' },
    get: (key: string) =>
      ({ firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '555-0100' })[key],
    getName: () => 'Ada Lovelace'
  });

  const installEsx = (players: Record<number, unknown>) =>
    __setResourceLookup((name) =>
      name === 'es_extended'
        ? {
            getSharedObject: () => ({
              GetPlayerFromId: (src: number) => players[src] ?? null,
              GetExtendedPlayers: () => Object.values(players)
            })
          }
        : undefined
    );

  it('resolves an online ESX player by phone, with the identifier as the citizenid', () => {
    installEsx({ 1: xPlayer(LICENSE, 1) });

    return expect(resolveByPhone('555-0100')).resolves.toEqual({
      citizenid: LICENSE,
      displayName: 'Ada Lovelace',
      phone: '555-0100'
    });
  });

  it('resolves an online ESX player by identifier', async () => {
    installEsx({ 1: xPlayer(LICENSE, 1) });

    await expect(resolve(LICENSE)).resolves.toMatchObject({
      citizenid: LICENSE,
      displayName: 'Ada Lovelace'
    });
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('resolves an offline ESX player out of the es_extended users table', async () => {
    // The offline half is a framework question — which table this server keeps players in —
    // so it lives behind `FrameworkBridge` rather than here. qb reads `players(citizenid)`
    // with its `charinfo` JSON; ESX reads es_extended's own core `users(identifier)`.
    installEsx({});
    dbMock.single.mockResolvedValueOnce({
      identifier: LICENSE,
      firstname: 'Ada',
      lastname: 'Lovelace'
    });

    await expect(resolve(LICENSE)).resolves.toEqual({
      citizenid: LICENSE,
      displayName: 'Ada Lovelace',
      // Not in core ESX, so it is reported absent rather than guessed at from whichever
      // community phone resource the operator happens to run.
      phone: null
    });

    const [sql, params] = dbMock.single.mock.calls[0];
    expect(sql).toContain('users');
    expect(sql).toContain('identifier');
    expect(params).toEqual([LICENSE]);
  });

  it('never queries the qb players table on ESX', async () => {
    installEsx({});
    dbMock.single.mockResolvedValueOnce(null);

    await resolve(LICENSE);

    expect(String(dbMock.single.mock.calls[0][0])).not.toContain('players');
  });

  it('cannot resolve an offline player by phone, and says so by finding nobody', async () => {
    // Core `users` has no phone column, so there is nothing to match on. Matching against
    // esx_phone's table would be right for one server population and silently wrong for the
    // rest, so this asks nothing at all rather than guessing.
    installEsx({});

    await expect(resolveByPhone('555-0100')).resolves.toBeNull();
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('degrades to a nameless player when the users table is not what it expects', async () => {
    // Another resource's table, which micaOS neither creates nor migrates: a missing column
    // or a missing table is not a micaOS bug and must not become an exception on a path that
    // is only trying to render a name. Returning null is exactly the pre-existing behaviour
    // for an unknown player, so the failure mode is the status quo rather than a crash.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __resetOfflineLookupWarnings();
    installEsx({});
    dbMock.single.mockRejectedValueOnce(new Error("Unknown column 'firstname'"));

    await expect(resolve(LICENSE)).resolves.toBeNull();
  });

  it('degrades the qb lookup the same way, rather than throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __resetOfflineLookupWarnings();
    __setResourceLookup(() => undefined);
    dbMock.single.mockRejectedValueOnce(new Error('players table is gone'));

    await expect(resolveByPhone('555-0100')).resolves.toBeNull();
  });

  it('reports a broken lookup once, not once per render', async () => {
    // A feed rendering forty offline authors would otherwise write forty identical lines.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    __resetOfflineLookupWarnings();
    installEsx({});
    dbMock.single.mockRejectedValue(new Error('Unknown column'));

    for (let i = 0; i < 5; i++) await resolve(LICENSE);

    expect(error).toHaveBeenCalledTimes(1);
  });
});
