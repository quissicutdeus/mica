// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { bridgeMock, convar, netHandlers, loadedSubscribers, emitNet } = vi.hoisted(() => {
  const net: Record<string, Function> = {};
  const loaded: { name: string; run: (src: number) => unknown }[] = [];
  const emit = vi.fn();
  (globalThis as any).onNet = (event: string, handler: Function) => {
    net[event] = handler;
  };
  (globalThis as any).emitNet = emit;
  // Set before the module loads: registration happens at import, from the convar.
  const value = { current: 'phone' };
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_phone_item' ? value.current : fallback;
  return {
    bridgeMock: {
      getPlayer: vi.fn(),
      countItem: vi.fn(),
      registerUsableItem: vi.fn(),
      framework: 'qb' as string
    },
    convar: value,
    netHandlers: net,
    loadedSubscribers: loaded,
    emitNet: emit
  };
});
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => bridgeMock.framework
}));
vi.mock('../lib/shell', () => ({
  onPlayerLoaded: (name: string, run: (src: number) => unknown) => {
    loadedSubscribers.push({ name, run });
  }
}));

import {
  PHONE_ITEM_CONVAR,
  __resetPhoneItemWarnings,
  evaluatePhoneItem,
  onPhoneStateChanged,
  phoneItemName
} from '../lib/phoneItem';
import { __resetRateLimits } from '../lib/rateLimit';
import { countInventoryItem, __setResourceLookup } from '../lib/framework/runtime';

/**
 * Registration happens when the module loads, from the convar the hoisted stub already held,
 * so it is read here before any `beforeEach` clears the mock.
 */
const registeredAtImport = bridgeMock.registerUsableItem.mock.calls[0] as
  [string, (source: number) => void] | undefined;

const SRC = 7;
const PLAYER = { citizenid: 'ABC12345', source: SRC, rawPlayer: {} };
const PUSH = 'mica:client:shell:phoneItem';
const OPEN = 'mica:client:shell:open';

/**
 * MICA-229: the phone opens only for a player holding the item `mica_phone_item` names.
 * The server counts and pushes; these drive the count and read what was pushed.
 */
describe('the phone item gate', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPhoneItemWarnings();
    __resetRateLimits();
    convar.current = 'phone';
    bridgeMock.framework = 'qb';
    bridgeMock.getPlayer.mockReturnValue(PLAYER);
    bridgeMock.countItem.mockReturnValue(1);
    (globalThis as any).source = SRC;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('is named by the convar the README documents', () => {
    expect(PHONE_ITEM_CONVAR).toBe('mica_phone_item');
    expect(phoneItemName()).toBe('phone');
  });

  it('registers the item as usable at start, and using it opens the phone', () => {
    expect(registeredAtImport).toBeDefined();
    const [item, onUse] = registeredAtImport!;
    expect(item).toBe('phone');

    onUse(SRC);

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, { gated: true, held: true });
    expect(emitNet).toHaveBeenCalledWith(OPEN, SRC);
  });

  it('subscribes to player load, so a fresh character is told where it stands', () => {
    const subscriber = loadedSubscribers.find((s) => s.name === 'phone-item');
    expect(subscriber).toBeDefined();

    subscriber!.run(SRC);

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, { gated: true, held: true });
  });

  it('tells a holder they are gated and held, and a non-holder they are not held', () => {
    bridgeMock.countItem.mockReturnValue(2);
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(bridgeMock.countItem).toHaveBeenCalledWith(PLAYER, 'phone');

    bridgeMock.countItem.mockReturnValue(0);
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: true, held: false });
    expect(emitNet).toHaveBeenLastCalledWith(PUSH, SRC, { gated: true, held: false });
  });

  it('pushes "not gated" when the convar is empty, so the client stops relaying', () => {
    convar.current = '';

    expect(phoneItemName()).toBeNull();
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, { gated: false, held: true });
  });

  it('pushes nothing for a source with no loaded character', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);

    expect(evaluatePhoneItem(SRC)).toBeNull();
    expect(emitNet).not.toHaveBeenCalled();
  });

  it('ignores the gate on a standalone server, and says so once', () => {
    bridgeMock.framework = 'standalone';

    expect(phoneItemName()).toBeNull();
    expect(phoneItemName()).toBeNull();
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('standalone');
  });

  it('refuses a name no inventory would accept, and says so once', () => {
    convar.current = "phone'; DROP TABLE";

    expect(phoneItemName()).toBeNull();
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not an item name');
  });

  it('fails open, loudly and once, when no inventory can count', () => {
    bridgeMock.countItem.mockReturnValue(null);

    expect(evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('left open');
  });

  describe('the "look again" event', () => {
    it('counts and pushes for a loaded player', () => {
      bridgeMock.countItem.mockReturnValue(0);

      netHandlers['mica:server:shell:checkPhoneItem']();

      expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, { gated: true, held: false });
    });

    it('is refused silently for a source with no loaded character', () => {
      bridgeMock.getPlayer.mockReturnValue(undefined);

      netHandlers['mica:server:shell:checkPhoneItem']();

      expect(bridgeMock.countItem).not.toHaveBeenCalled();
      expect(emitNet).not.toHaveBeenCalled();
    });
  });
});

/**
 * MICA-284: whoever needs to know a player's phone situation may have changed is told from
 * here, because this is where all three triggers are observed. The number sync is the first
 * subscriber, and it cannot hang off `onPlayerLoaded` alone without going stale the moment a
 * player picks up a second phone.
 */
describe('the phone-state registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPhoneItemWarnings();
    __resetRateLimits();
    convar.current = 'phone';
    bridgeMock.framework = 'qb';
    bridgeMock.getPlayer.mockReturnValue(PLAYER);
    bridgeMock.countItem.mockReturnValue(1);
    (globalThis as any).source = SRC;
  });

  it('tells a subscriber on load, on use, and on the look-again event', () => {
    const run = vi.fn();
    onPhoneStateChanged('test-load-use-relay', run);

    loadedSubscribers.find((s) => s.name === 'phone-item')!.run(SRC);
    registeredAtImport![1](SRC);
    netHandlers['mica:server:shell:checkPhoneItem']();

    expect(run.mock.calls).toEqual([[SRC], [SRC], [SRC]]);
  });

  it('tells nobody about a source with no loaded character', () => {
    const run = vi.fn();
    onPhoneStateChanged('test-unloaded', run);
    bridgeMock.getPlayer.mockReturnValue(undefined);

    evaluatePhoneItem(SRC);

    expect(run).not.toHaveBeenCalled();
  });

  it('still tells the others when one subscriber throws or rejects, and names it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    onPhoneStateChanged('test-throws', () => {
      throw new Error('boom');
    });
    onPhoneStateChanged('test-rejects', () => Promise.reject(new Error('later')));
    onPhoneStateChanged('test-after', after);

    evaluatePhoneItem(SRC);
    await Promise.resolve();

    expect(after).toHaveBeenCalledWith(SRC);
    const said = error.mock.calls.map((c) => String(c[0]));
    expect(said.some((line) => line.includes("'test-throws' threw"))).toBe(true);
    expect(said.some((line) => line.includes("'test-rejects' rejected"))).toBe(true);
    error.mockRestore();
  });
});

describe('countInventoryItem', () => {
  afterEach(() => {
    __setResourceLookup();
  });

  it('asks ox_inventory first, wherever it is present', () => {
    const GetItemCount = vi.fn(() => 3);
    __setResourceLookup((name) => (name === 'ox_inventory' ? { GetItemCount } : undefined));
    const qbPlayer = { Functions: { GetItemByName: vi.fn(() => ({ amount: 9 })) } };

    expect(countInventoryItem(SRC, qbPlayer, 'phone')).toBe(3);
    expect(GetItemCount).toHaveBeenCalledWith(SRC, 'phone');
    expect(qbPlayer.Functions.GetItemByName).not.toHaveBeenCalled();
  });

  it("reads a qb player's GetItemByName, and none as zero", () => {
    __setResourceLookup(() => undefined);
    const held = { Functions: { GetItemByName: () => ({ amount: 2 }) } };
    const none = { Functions: { GetItemByName: () => undefined } };

    expect(countInventoryItem(SRC, held, 'phone')).toBe(2);
    expect(countInventoryItem(SRC, none, 'phone')).toBe(0);
  });

  it('reads an ESX xPlayer through the qb-shaped view', () => {
    __setResourceLookup(() => undefined);
    const view = { PlayerData: {}, xPlayer: { getInventoryItem: () => ({ count: 1 }) } };

    expect(countInventoryItem(SRC, view, 'phone')).toBe(1);
  });

  it('answers null, not zero, when nothing here can count', () => {
    __setResourceLookup(() => undefined);

    expect(countInventoryItem(SRC, {}, 'phone')).toBeNull();
    expect(countInventoryItem(SRC, undefined, 'phone')).toBeNull();
  });

  it('treats a shapeless answer as none rather than as a count', () => {
    __setResourceLookup(() => undefined);
    const odd = { Functions: { GetItemByName: () => ({ amount: 'two' }) } };
    const negative = { Functions: { GetItemByName: () => ({ amount: -1 }) } };

    expect(countInventoryItem(SRC, odd, 'phone')).toBe(0);
    expect(countInventoryItem(SRC, negative, 'phone')).toBe(0);
  });
});
