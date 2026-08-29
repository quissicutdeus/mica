import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FrameworkBridge, __setResourceLookup } from '../lib/FrameworkBridge';

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
