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
import { __setResourceLookup } from '../lib/FrameworkBridge';

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
 * `PlayerDirectory` reads `rawPlayer.PlayerData.charinfo` and does not know which framework
 * produced it. That is the point of normalising an `xPlayer` into the qb shape inside
 * `FrameworkBridge`: this file needed no ESX branch, and these tests exist to prove that
 * rather than to assume it.
 *
 * The online half works. The **offline half does not, and cannot yet** — see the last test.
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

  it('finds nobody offline, because the SQL fallback reads qb tables — MICA-150 gap', () => {
    // Both fallbacks here query `players` (`charinfo` JSON). ESX has neither: it has
    // `users(identifier, firstname, lastname)`, and a phone number is not core ESX at all, so
    // there is no column to substitute without knowing which community phone resource the
    // operator runs. Pinned as a known limitation rather than guessed at: on ESX, an offline
    // player renders with no name, and messaging an offline player by number does not resolve.
    installEsx({});
    dbMock.single.mockResolvedValue(null);

    return expect(resolveByPhone('555-0100')).resolves.toBeNull();
  });
});
