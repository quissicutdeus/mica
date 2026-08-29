import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FrameworkBridge,
  __setResourceLookup,
  citizenIdFromIdentifier
} from '../lib/FrameworkBridge';

/**
 * Every ownership check in gPhone resolves an identity through here, and it had no test.
 *
 * A repository scopes by citizenid and asks no questions about where it came from, so
 * whatever this returns *is* the player as far as the rest of the server is concerned.
 */

const qbx = (player: unknown) => ({ qbx_core: { GetPlayer: () => player } });
const qb = (player: unknown) => ({
  'qb-core': { GetCoreObject: () => ({ Functions: { GetPlayer: () => player } }) }
});

const useResources = (map: Record<string, unknown>) =>
  __setResourceLookup((name) => (map as Record<string, any>)[name]);

beforeEach(() => vi.restoreAllMocks());
afterEach(() => __setResourceLookup());

describe('FrameworkBridge.getPlayer', () => {
  it('reads the citizenid QBX gives it', () => {
    useResources(qbx({ PlayerData: { citizenid: 'CIT_A', charinfo: { phone: '5551000' } } }));

    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
    expect(FrameworkBridge.getPlayerPhone(1)).toBe('5551000');
  });

  it('reads the citizenid QB Core gives it', () => {
    useResources(qb({ PlayerData: { citizenid: 'CIT_B' } }));
    expect(FrameworkBridge.getCitizenId(2)).toBe('CIT_B');
  });

  it('refuses to invent an identity for a player the framework will not name', () => {
    // It used to answer `src_7`. A server id is per-connection and reused, so the next
    // player given source 7 inherited the previous one's contacts, notes and photos —
    // every repository scopes by citizenid, and that one looked entirely valid.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources(qbx({ PlayerData: { charinfo: { phone: '5551000' } } }));

    expect(FrameworkBridge.getPlayer(7)).toBeNull();
    expect(FrameworkBridge.getCitizenId(7)).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).not.toContain('src_7');
  });

  it('refuses the same way on QB Core', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources(qb({ PlayerData: {} }));
    expect(FrameworkBridge.getPlayer(7)).toBeNull();
  });

  it('is null when nobody is on that source, without logging an error', () => {
    // An empty source is ordinary — a disconnect mid-request. Only a *shapeless* player
    // is worth shouting about.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources(qbx(null));

    expect(FrameworkBridge.getPlayer(3)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('is null when no framework is present at all', () => {
    useResources({});
    expect(FrameworkBridge.getPlayer(1)).toBeNull();
    expect(FrameworkBridge.getAllPlayers()).toEqual({});
  });

  it('survives a framework that throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources({
      qbx_core: {
        GetPlayer: () => {
          throw new Error('core exploded');
        }
      }
    });
    expect(FrameworkBridge.getPlayer(1)).toBeNull();
  });
});

describe('FrameworkBridge lookups', () => {
  const online = {
    5: { PlayerData: { citizenid: 'CIT_A', charinfo: { phone: '5551000' } } },
    9: { PlayerData: { citizenid: 'CIT_B', charinfo: { phone: '5552000' } } }
  };

  it('finds the source of an online character', () => {
    useResources({ qbx_core: { GetQBPlayers: () => online } });
    expect(FrameworkBridge.getSourceByCitizenId('CIT_B')).toBe(9);
  });

  it('is null for an offline character, and for no character', () => {
    useResources({ qbx_core: { GetQBPlayers: () => online } });
    expect(FrameworkBridge.getSourceByCitizenId('CIT_NOBODY')).toBeNull();
    expect(FrameworkBridge.getSourceByCitizenId('')).toBeNull();
  });

  it('finds a player by phone number', () => {
    useResources({
      qbx_core: {
        GetQBPlayers: () => online,
        GetPlayer: (src: number) => (online as Record<number, unknown>)[src]
      }
    });
    expect(FrameworkBridge.getPlayerByPhone('5552000')?.citizenid).toBe('CIT_B');
    expect(FrameworkBridge.getPlayerByPhone('5559999')).toBeNull();
  });
});

describe('FrameworkBridge.removeInventoryItem', () => {
  it('uses the player own RemoveItem when the framework has one', () => {
    useResources({});
    const RemoveItem = vi.fn(() => true);
    const ok = FrameworkBridge.removeInventoryItem(1, { Functions: { RemoveItem } }, 'battery', 1);

    expect(ok).toBe(true);
    expect(RemoveItem).toHaveBeenCalledWith('battery', 1);
  });

  it('falls back to ox_inventory', () => {
    const RemoveItem = vi.fn(() => true);
    useResources({ ox_inventory: { RemoveItem } });

    expect(FrameworkBridge.removeInventoryItem(1, {}, 'battery', 1)).toBe(true);
    expect(RemoveItem).toHaveBeenCalledWith(1, 'battery', 1);
  });

  it('reports a refusal as a refusal', () => {
    useResources({ ox_inventory: { RemoveItem: () => false } });
    expect(FrameworkBridge.removeInventoryItem(1, {}, 'battery', 1)).toBe(false);
  });

  it('allows the action, loudly, when there is no inventory to remove from', () => {
    // Deliberate fail-open, and worth knowing about: a server with a framework but no
    // recognized inventory gets the item's effect without the item being consumed. The
    // alternative is a feature that silently never works. Pinned here so the choice is
    // visible rather than a stray `return true`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useResources({});

    expect(FrameworkBridge.removeInventoryItem(1, {}, 'battery', 1)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * Money, and the fact that this file is 200 lines of `any`-typed duck-typing against two
 * resources gPhone does not pin.
 *
 * `FrameworkPlayer` declares `removeMoney(): boolean` and `getMoney(): number`, and until
 * MICA-133 those declarations were decorative: `player` is `any`, so whatever qbx_core or
 * qb-core handed back was returned straight through and TypeScript could not object. If a
 * framework release made `RemoveMoney` async, the promise was truthy, `Payments` read it as a
 * completed debit and credited the payee anyway. No attacker, no error, no modified client —
 * it arrives in somebody else's release notes, and the first sign is an economy that does not
 * balance.
 *
 * So the boundary coerces, and every branch below fails closed. Nothing but a literal `true`
 * is a completed move, and nothing but a finite number is a balance.
 */
describe('FrameworkBridge money is believed only when the framework says so plainly', () => {
  const player = (Functions: Record<string, unknown>) => ({
    PlayerData: { citizenid: 'CIT_A', money: { bank: 500, cash: 20 } },
    Functions
  });

  /** Everything an upgraded framework might plausibly answer with instead of a boolean. */
  const notBooleans: [string, () => unknown][] = [
    ['a promise', () => Promise.resolve(true)],
    ['a result object', () => ({ success: true })],
    ['a status code', () => 1],
    ['a truthy string', () => 'ok'],
    ['nil, from a renamed method', () => undefined]
  ];

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe.each([
    ['qbx_core', qbx],
    ['qb-core', qb]
  ])('on %s', (_name, install) => {
    it.each(notBooleans)('refuses a debit answered with %s', (_label, RemoveMoney) => {
      useResources(install(player({ RemoveMoney })));

      expect(FrameworkBridge.getPlayer(1)?.removeMoney('bank', 50)).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });

    it.each(notBooleans)('refuses a credit answered with %s', (_label, AddMoney) => {
      useResources(install(player({ AddMoney })));

      expect(FrameworkBridge.getPlayer(1)?.addMoney('bank', 50)).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });

    it('still takes a plain `true` as the move having happened', () => {
      useResources(install(player({ RemoveMoney: () => true, AddMoney: () => true })));
      const bridged = FrameworkBridge.getPlayer(1);

      expect(bridged?.removeMoney('bank', 50)).toBe(true);
      expect(bridged?.addMoney('bank', 50)).toBe(true);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('takes a plain `false` as an ordinary refusal, and does not shout about it', () => {
      // An overdraw is not a contract change. Only a *shapeless* answer is worth logging,
      // for the same reason `getPlayer` only shouts about a player with no citizenid.
      useResources(install(player({ RemoveMoney: () => false, AddMoney: () => false })));
      const bridged = FrameworkBridge.getPlayer(1);

      expect(bridged?.removeMoney('bank', 50)).toBe(false);
      expect(bridged?.addMoney('bank', 50)).toBe(false);
      expect(console.error).not.toHaveBeenCalled();
    });

    it.each([
      ['a promise', () => Promise.resolve(500)],
      ['undefined', () => undefined],
      ['NaN', () => NaN],
      ['Infinity', () => Infinity],
      ['a numeric string', () => '500']
    ])('reports a balance it cannot determine as unaffordable — %s', (_label, GetMoney) => {
      useResources(install(player({ GetMoney })));

      const balance = FrameworkBridge.getPlayer(1)!.getMoney('bank');

      // The property every caller depends on, rather than the sentinel itself: `balance <
      // amount` has to be true for *any* amount, so `Payments.ts` and `Hodlr.ts` refuse at
      // their existing insufficient-funds check instead of falling through to the debit.
      expect(balance < 1).toBe(true);
      expect(balance < Number.MIN_SAFE_INTEGER).toBe(true);
      expect(console.error).toHaveBeenCalled();
    });

    it('passes a real balance through untouched, including zero', () => {
      useResources(install(player({ GetMoney: () => 0 })));

      expect(FrameworkBridge.getPlayer(1)?.getMoney('bank')).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  it('guards the PlayerData fallback too, not just the framework call', () => {
    // No `GetMoney` handler at all, so the balance is read off the player table. A string
    // there is just as undeterminable as a promise from a call.
    useResources(
      qbx({ PlayerData: { citizenid: 'CIT_A', money: { bank: '500' } }, Functions: {} })
    );

    expect(FrameworkBridge.getPlayer(1)!.getMoney('bank') < 1).toBe(true);
  });

  it('guards the qbx_core export path as well as the player handler', () => {
    useResources({
      qbx_core: {
        GetPlayer: () => ({ PlayerData: { citizenid: 'CIT_A' }, Functions: {} }),
        GetMoney: () => Promise.resolve(500),
        AddMoney: () => Promise.resolve(true)
      }
    });
    const bridged = FrameworkBridge.getPlayer(1)!;

    expect(bridged.getMoney('bank') < 1).toBe(true);
    expect(bridged.addMoney('bank', 50)).toBe(false);
  });
});

/**
 * ESX (MICA-150).
 *
 * The third framework, and the first that does not share qb's shape. Two things are asserted
 * here rather than one: that an `xPlayer` reaches the rest of the server wearing the qb shape
 * everything downstream reads, and that MICA-133's fail-closed money rule survives a
 * framework whose money calls return nothing at all to coerce.
 */

/** An `xPlayer`, with observable accounts and the ESX accessors the bridge reaches for. */
const xPlayer = (
  identifier: string,
  opts: {
    source?: number;
    bank?: number;
    cash?: number;
    variables?: Record<string, string>;
    getAccount?: (name: string) => unknown;
    addAccountMoney?: (name: string, amount: number) => unknown;
    removeAccountMoney?: (name: string, amount: number) => unknown;
    omit?: readonly string[];
  } = {}
) => {
  const accounts: Record<string, number> = { bank: opts.bank ?? 500, money: opts.cash ?? 20 };
  const variables: Record<string, string> = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: '5551000',
    ...opts.variables
  };

  const player: Record<string, unknown> = {
    identifier,
    source: opts.source ?? 1,
    variables,
    get: (key: string) => variables[key],
    getName: () => `${variables.firstName} ${variables.lastName}`.trim(),
    getAccount: opts.getAccount ?? ((name: string) => ({ name, money: accounts[name] })),
    addAccountMoney:
      opts.addAccountMoney ??
      ((name: string, amount: number) => {
        accounts[name] += amount;
      }),
    removeAccountMoney:
      opts.removeAccountMoney ??
      ((name: string, amount: number) => {
        accounts[name] -= amount;
      }),
    setMeta: vi.fn(),
    removeInventoryItem: vi.fn(),
    read: (name = 'bank') => accounts[name]
  };

  for (const key of opts.omit ?? []) delete player[key];
  return player as any;
};

/** `es_extended` as an installed resource, exposing the shared object by export. */
const esx = (players: Record<number, any>, extras: Record<string, unknown> = {}) => {
  const shared = {
    GetPlayerFromId: (src: number) => players[src] ?? null,
    GetExtendedPlayers: () => Object.values(players),
    ...extras
  };
  return { es_extended: { getSharedObject: () => shared } } as any;
};

const LICENSE = 'license:0123456789abcdef0123456789abcdef01234567';

describe('FrameworkBridge on ESX — identity', () => {
  it('keys the player on the ESX identifier, which is what citizenid means here', () => {
    // The MICA-150 decision, pinned: an ESX identifier *is* the citizenid. ESX issues it per
    // account rather than per character, so ESX gets one phone per player where qb gets one
    // per character. That is the intended behaviour, and this is where it is asserted.
    useResources(esx({ 1: xPlayer(LICENSE) }));

    expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE);
  });

  it('exposes the mapping as one named function, so it can be changed in one place', () => {
    // Every ownership predicate on this server is a citizenid comparison. An owner wanting
    // per-character ESX identity edits this function and no call site.
    expect(citizenIdFromIdentifier('steam:110000112345678')).toBe('steam:110000112345678');
    expect(citizenIdFromIdentifier('  license:abc  ')).toBe('license:abc');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a number', 42]
  ])('refuses to serve a player whose identifier is %s', (_label, identifier) => {
    // The same rule as the qb branches: an identity gPhone cannot read is not one it invents.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources(esx({ 1: xPlayer(identifier as any) }));

    expect(FrameworkBridge.getPlayer(1)).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain('es_extended');
  });

  it('reads the identifier from getIdentifier() when the field is absent', () => {
    const player = xPlayer(LICENSE, { omit: ['identifier'] });
    player.getIdentifier = () => LICENSE;
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE);
  });

  it('is null when nobody is on that source, without logging', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useResources(esx({}));

    expect(FrameworkBridge.getPlayer(3)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('prefers a qb core when both are installed, rather than switching identity schemes', () => {
    // A live server changing which string it calls a citizenid is a data migration, not a
    // fallback. Whichever core already owns the rows keeps them.
    useResources({
      ...qbx({ PlayerData: { citizenid: 'CIT_A' } }),
      ...esx({ 1: xPlayer(LICENSE) })
    });

    expect(FrameworkBridge.getCitizenId(1)).toBe('CIT_A');
  });

  it('falls back to the esx:getSharedObject event on a build with no export', () => {
    (globalThis as any).emit = (event: string, cb: (obj: unknown) => void) => {
      if (event === 'esx:getSharedObject') cb({ GetPlayerFromId: () => xPlayer(LICENSE) });
    };
    __setResourceLookup((name) => (name === 'es_extended' ? {} : undefined));

    expect(FrameworkBridge.getCitizenId(1)).toBe(LICENSE);
    delete (globalThis as any).emit;
  });
});

describe('FrameworkBridge on ESX — the qb shape everything downstream reads', () => {
  it('presents charinfo, so names and phone lookups keep working unchanged', () => {
    // `PlayerDirectory`, `Messages` and `Music` read PlayerData.charinfo off `rawPlayer`, and
    // five callers read it off `getAllPlayers()`. Normalising here is what spares all eight a
    // framework check of their own.
    useResources(esx({ 1: xPlayer(LICENSE) }));
    const player = FrameworkBridge.getPlayer(1)!;

    expect(player.phone).toBe('5551000');
    expect(player.rawPlayer.PlayerData).toMatchObject({
      citizenid: LICENSE,
      source: 1,
      charinfo: { firstname: 'Ada', lastname: 'Lovelace', phone: '5551000' }
    });
  });

  it('keeps the real xPlayer reachable rather than discarding it', () => {
    useResources(esx({ 1: xPlayer(LICENSE) }));
    expect(FrameworkBridge.getPlayer(1)!.rawPlayer.xPlayer.identifier).toBe(LICENSE);
  });

  it('takes a single-word getName() as a first name rather than reporting none', () => {
    const player = xPlayer(LICENSE, { variables: { firstName: '', lastName: '' } });
    player.getName = () => 'Ada';
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getPlayer(1)!.rawPlayer.PlayerData.charinfo).toMatchObject({
      firstname: 'Ada',
      lastname: ''
    });
  });

  it('reports a blank name as blank rather than as a stray space', () => {
    useResources(esx({ 1: xPlayer(LICENSE, { variables: { firstName: '', lastName: '' } }) }));

    expect(FrameworkBridge.getPlayer(1)!.rawPlayer.PlayerData.charinfo).toMatchObject({
      firstname: '',
      lastname: ''
    });
  });

  it('reports no phone when the build stores one nowhere, rather than guessing', () => {
    // A phone number is not core ESX at all. Every reader already handles null.
    useResources(esx({ 1: xPlayer(LICENSE, { variables: { phoneNumber: '' } }) }));
    expect(FrameworkBridge.getPlayer(1)!.phone).toBeUndefined();
  });

  it('survives a variable accessor that throws', () => {
    const player = xPlayer(LICENSE);
    player.get = () => {
      throw new Error('addon exploded');
    };
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getPlayer(1)!.citizenid).toBe(LICENSE);
  });

  it('carries metadata through for the legacy battery read', () => {
    const player = xPlayer(LICENSE);
    player.getMeta = () => ({ gphone_battery: 42 });
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getPlayer(1)!.rawPlayer.PlayerData.metadata).toEqual({
      gphone_battery: 42
    });
  });
});

describe('FrameworkBridge on ESX — listing players', () => {
  const online = () => ({
    5: xPlayer('license:aaa', { source: 5, variables: { phoneNumber: '5551000' } }),
    9: xPlayer('license:bbb', { source: 9, variables: { phoneNumber: '5552000' } })
  });

  it('lists every connected player in the qb shape', () => {
    useResources(esx(online()));
    const players = FrameworkBridge.getAllPlayers() as Record<number, any>;

    expect(Object.keys(players)).toEqual(['5', '9']);
    expect(players[9].PlayerData.citizenid).toBe('license:bbb');
  });

  it('finds the source of an online player, and a player by phone', () => {
    // Both walk `getAllPlayers()` reading `PlayerData.citizenid` / `.charinfo.phone`, so this
    // asserts that the normalisation is exactly what those two already expect.
    useResources(esx(online()));

    expect(FrameworkBridge.getSourceByCitizenId('license:bbb')).toBe(9);
    expect(FrameworkBridge.getSourceByCitizenId('license:nobody')).toBeNull();
    expect(FrameworkBridge.getPlayerByPhone('5552000')?.citizenid).toBe('license:bbb');
    expect(FrameworkBridge.getPlayerByPhone('5559999')).toBeNull();
  });

  it('falls back to ESX.Players when the build has no GetExtendedPlayers', () => {
    const players = online();
    __setResourceLookup((name) =>
      name === 'es_extended'
        ? { getSharedObject: () => ({ Players: players, GetPlayerFromId: () => null }) }
        : undefined
    );

    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['5', '9']);
  });

  it('falls back to GetPlayers ids on the oldest builds', () => {
    const players = online() as Record<number, any>;
    __setResourceLookup((name) =>
      name === 'es_extended'
        ? {
            getSharedObject: () => ({
              GetPlayers: () => ['5', '9'],
              GetPlayerFromId: (src: number) => players[src] ?? null
            })
          }
        : undefined
    );

    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['5', '9']);
  });

  it('never lists a player it cannot name', () => {
    // A nameless entry here would reach `proximity` and `pushMany` as a real recipient.
    useResources(esx({ 5: xPlayer('', { source: 5 }), 9: xPlayer('license:bbb', { source: 9 }) }));

    expect(Object.keys(FrameworkBridge.getAllPlayers())).toEqual(['9']);
  });

  it('is empty when es_extended is not installed', () => {
    useResources({});
    expect(FrameworkBridge.getAllPlayers()).toEqual({});
  });
});

/**
 * The MICA-133 rule, one framework over, and why it needed a different mechanism.
 *
 * qb answers a money call with a boolean, so `moved` has something to judge. ESX's
 * `addAccountMoney` and `removeAccountMoney` **return nothing**: there is no answer to coerce.
 * Refusing their `undefined` outright would break every honest ESX transfer; trusting the call
 * because it did not throw is the fail-open MICA-133 closed. So the bridge reads the balance
 * back, through the same `balanceOf` coercion `getMoney` uses, and the account is the witness.
 */
describe('FrameworkBridge on ESX — money is proved by the balance, never by the return', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Everything a build might hand back where a number belongs. */
  const notBalances: [string, unknown][] = [
    ['a promise', Promise.resolve(500)],
    ['an object', { money: 500 }],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a numeric string', '500']
  ];

  it.each(notBalances)('reports a balance of %s as unaffordable', (_label, money) => {
    useResources(esx({ 1: xPlayer(LICENSE, { getAccount: () => ({ money }) }) }));

    const balance = FrameworkBridge.getPlayer(1)!.getMoney('bank');

    expect(balance < 1).toBe(true);
    expect(balance < Number.MIN_SAFE_INTEGER).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it.each(notBalances)('refuses a debit when the balance reads as %s', (_label, money) => {
    // Refused *before* the framework is called: a blind write followed by a read it cannot
    // interpret manufactures the stranded case rather than avoiding it.
    const removeAccountMoney = vi.fn();
    useResources(
      esx({ 1: xPlayer(LICENSE, { getAccount: () => ({ money }), removeAccountMoney }) })
    );

    expect(FrameworkBridge.getPlayer(1)!.removeMoney('bank', 50)).toBe(false);
    expect(removeAccountMoney).not.toHaveBeenCalled();
  });

  it.each(notBalances)('refuses a credit when the balance reads as %s', (_label, money) => {
    const addAccountMoney = vi.fn();
    useResources(esx({ 1: xPlayer(LICENSE, { getAccount: () => ({ money }), addAccountMoney }) }));

    expect(FrameworkBridge.getPlayer(1)!.addMoney('bank', 50)).toBe(false);
    expect(addAccountMoney).not.toHaveBeenCalled();
  });

  it('refuses every way when getAccount returns nothing at all', () => {
    useResources(esx({ 1: xPlayer(LICENSE, { getAccount: () => undefined }) }));
    const player = FrameworkBridge.getPlayer(1)!;

    expect(player.getMoney('bank') < 1).toBe(true);
    expect(player.addMoney('bank', 50)).toBe(false);
    expect(player.removeMoney('bank', 50)).toBe(false);
  });

  it.each([
    ['a promise', () => Promise.resolve(true)],
    ['a result object', () => ({ success: true })],
    ['a status code', () => 1],
    ['a truthy string', () => 'ok'],
    ['nothing at all', () => undefined],
    ['NaN', () => NaN]
  ])(
    'refuses a credit that answers with %s and does not move the balance',
    (_label, addAccountMoney) => {
      // The regression that matters. A truthy answer from a call that did nothing is exactly
      // the shape that let money be invented on qb; here the balance is the only witness.
      const player = xPlayer(LICENSE, { bank: 500, addAccountMoney });
      useResources(esx({ 1: player }));

      expect(FrameworkBridge.getPlayer(1)!.addMoney('bank', 50)).toBe(false);
      expect(player.read('bank')).toBe(500);
      expect(console.error).toHaveBeenCalled();
    }
  );

  it.each([
    ['a promise', () => Promise.resolve(true)],
    ['a result object', () => ({ success: true })],
    ['nothing at all', () => undefined],
    ['NaN', () => NaN]
  ])(
    'refuses a debit that answers with %s and does not move the balance',
    (_label, removeAccountMoney) => {
      const player = xPlayer(LICENSE, { bank: 500, removeAccountMoney });
      useResources(esx({ 1: player }));

      expect(FrameworkBridge.getPlayer(1)!.removeMoney('bank', 50)).toBe(false);
      expect(player.read('bank')).toBe(500);
    }
  );

  it('believes a move that answers with nothing but did move the balance', () => {
    // ESX's own contract: `addAccountMoney` returns nil and the account changes. Refusing this
    // would refuse every honest ESX transfer, which is why the balance is the witness rather
    // than the return value.
    const player = xPlayer(LICENSE, { bank: 500 });
    useResources(esx({ 1: player }));
    const bridged = FrameworkBridge.getPlayer(1)!;

    expect(bridged.addMoney('bank', 50)).toBe(true);
    expect(player.read('bank')).toBe(550);
    expect(bridged.removeMoney('bank', 100)).toBe(true);
    expect(player.read('bank')).toBe(450);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reads and moves cash on the money account, which is ESX for cash', () => {
    const player = xPlayer(LICENSE, { cash: 75 });
    useResources(esx({ 1: player }));
    const bridged = FrameworkBridge.getPlayer(1)!;

    expect(bridged.getMoney('cash')).toBe(75);
    expect(bridged.addMoney('cash', 25)).toBe(true);
    expect(player.read('money')).toBe(100);
  });

  it('reads cash through getMoney() on a build with no accounts', () => {
    const player = xPlayer(LICENSE, { omit: ['getAccount'] });
    player.getMoney = () => 75;
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getPlayer(1)!.getMoney('cash')).toBe(75);
  });

  it('fails closed when the build exposes no money handler at all', () => {
    useResources(esx({ 1: xPlayer(LICENSE, { omit: ['addAccountMoney', 'removeAccountMoney'] }) }));
    const bridged = FrameworkBridge.getPlayer(1)!;

    expect(bridged.addMoney('bank', 50)).toBe(false);
    expect(bridged.removeMoney('bank', 50)).toBe(false);
  });

  it('fails closed when a money call throws', () => {
    useResources(
      esx({
        1: xPlayer(LICENSE, {
          addAccountMoney: () => {
            throw new Error('account locked');
          }
        })
      })
    );

    expect(FrameworkBridge.getPlayer(1)!.addMoney('bank', 50)).toBe(false);
  });

  it('refuses, loudly, when the balance stops being readable mid-move', () => {
    // Readable before and not after: the one case where the money may genuinely have moved and
    // this cannot tell. It refuses, and says so, because a human has to reconcile it.
    let reads = 0;
    useResources(
      esx({
        1: xPlayer(LICENSE, { getAccount: () => ({ money: reads++ === 0 ? 500 : undefined }) })
      })
    );

    expect(FrameworkBridge.getPlayer(1)!.addMoney('bank', 50)).toBe(false);
    expect(
      vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes('by hand'))
    ).toBe(true);
  });
});

describe('FrameworkBridge on ESX — items, metadata and usable items', () => {
  it('consumes an item through the ESX inventory', () => {
    const player = xPlayer(LICENSE);
    useResources(esx({ 1: player }));

    expect(FrameworkBridge.getPlayer(1)!.removeItem('battery_bank', 1)).toBe(true);
    expect(player.removeInventoryItem).toHaveBeenCalledWith('battery_bank', 1);
  });

  it('falls through to ox_inventory when the player has no inventory call', () => {
    const RemoveItem = vi.fn(() => true);
    useResources({
      ...esx({ 1: xPlayer(LICENSE, { omit: ['removeInventoryItem'] }) }),
      ox_inventory: { RemoveItem }
    });

    expect(FrameworkBridge.getPlayer(1)!.removeItem('battery_bank', 1)).toBe(true);
    expect(RemoveItem).toHaveBeenCalledWith(1, 'battery_bank', 1);
  });

  it('mirrors metadata through setMeta when the build has one', () => {
    const player = xPlayer(LICENSE);
    useResources(esx({ 1: player }));

    FrameworkBridge.getPlayer(1)!.setMeta('gphone_battery', 42);
    expect(player.setMeta).toHaveBeenCalledWith('gphone_battery', 42);
  });

  it('degrades to a session variable on a build with no setMeta', () => {
    // Not persisted, and less than qb offers — but the only caller is Battery mirroring for
    // *other* resources, and gPhone's own table is written either way.
    const player = xPlayer(LICENSE, { omit: ['setMeta'] });
    player.set = vi.fn();
    useResources(esx({ 1: player }));

    FrameworkBridge.getPlayer(1)!.setMeta('gphone_battery', 42);
    expect(player.set).toHaveBeenCalledWith('gphone_battery', 42);
  });

  it('drops the write, once per player, on a build with neither — and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A source of its own: the "said once" set is module state that outlives a test.
    useResources(esx({ 11: xPlayer(LICENSE, { source: 11, omit: ['setMeta'] }) }));
    const bridged = FrameworkBridge.getPlayer(11)!;

    expect(() => {
      bridged.setMeta('gphone_battery', 42);
      bridged.setMeta('gphone_battery', 43);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('registers a usable item through ESX', () => {
    const RegisterUsableItem = vi.fn();
    useResources(esx({}, { RegisterUsableItem }));
    const cb = () => {};

    FrameworkBridge.registerUsableItem('battery_bank', cb);
    expect(RegisterUsableItem).toHaveBeenCalledWith('battery_bank', cb);
  });
});
