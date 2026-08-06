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
