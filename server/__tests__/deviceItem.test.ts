// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { bridgeMock, convar, netHandlers, loadedSubscribers, loadedForgetters, emitNet } =
  vi.hoisted(() => {
    const net: Record<string, Function> = {};
    const loaded: { name: string; run: (src: number) => unknown }[] = [];
    /** What `forgetOnPlayerLoaded` was handed, which the real registry runs before `loaded`. */
    const forgetters: { name: string; forget: (src: number, previous: string) => void }[] = [];
    const emit = vi.fn();
    (globalThis as any).onNet = (event: string, handler: Function) => {
      net[event] = handler;
    };
    (globalThis as any).emitNet = emit;
    // Set before the module loads: registration happens at import, from the convars. The
    // tablet is off at import, so the module under test is the default install's.
    const value = {
      current: 'phone',
      tablet: 'false',
      tabletItem: 'tablet',
      battery: 'battery_bank'
    };
    (globalThis as any).GetConvar = (name: string, fallback: string) => {
      if (name === 'mica_phone_item') return value.current;
      if (name === 'mica_tablet') return value.tablet;
      if (name === 'mica_tablet_item') return value.tabletItem;
      if (name === 'mica_battery_item') return value.battery;
      return fallback;
    };
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
      loadedForgetters: forgetters,
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
  },
  forgetOnPlayerLoaded: (name: string, forget: (src: number, previous: string) => void) => {
    loadedForgetters.push({ name, forget });
  }
}));

import {
  DEVICE_CONVARS,
  PHONE_ITEM_CONVAR,
  __resetPhoneItemWarnings,
  deviceItemName,
  enabledDevices,
  evaluateDeviceItems,
  holdsDevice,
  isDeviceEnabled,
  onDeviceStateChanged,
  onPhoneStateChanged,
  phoneItemName
} from '../lib/deviceItem';
import { ALL_DEVICES, DEVICES } from '@mica/shared/devices';
import { __resetRateLimits } from '../lib/rateLimit';
import { countInventoryItem, __setResourceLookup } from '../lib/framework/runtime';

/**
 * Registration happens when the module loads, from the convar the hoisted stub already held,
 * so it is read here before any `beforeEach` clears the mock.
 */
const registrationsAtImport = [...bridgeMock.registerUsableItem.mock.calls] as [
  string,
  (source: number, used?: { slot?: unknown }) => void
][];
const registeredAtImport = registrationsAtImport[0] as
  [string, (source: number, used?: { slot?: unknown }) => void] | undefined;

const SRC = 7;
const PLAYER = { citizenid: 'ABC12345', source: SRC, rawPlayer: {} };
const PUSH = 'mica:client:shell:phoneItem';
const SERVER_ENABLED = 'mica:client:shell:setServerEnabled';
const OPEN = 'mica:client:shell:open';
const CHECK = 'mica:server:shell:checkDeviceItem';

/** The phone's push, with the device fields every push carries since MICA-263. */
const phone = (gated: boolean, held: boolean) => ({ device: 'phone', enabled: true, gated, held });
const TABLET_OFF = { device: 'tablet', enabled: false, gated: false, held: false };

/** The phone's half of a pass, in the `{ gated, held }` shape these cases were written against. */
const evaluatePhoneItem = (src: number) => {
  const state = evaluateDeviceItems(src)?.find((s) => s.device === 'phone');
  return state ? { gated: state.gated, held: state.held } : null;
};

/** Let anything a handler left running land. Nothing should be: a pass is synchronous again. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const resetConvars = (): void => {
  convar.current = 'phone';
  convar.tablet = 'false';
  convar.tabletItem = 'tablet';
  convar.battery = 'battery_bank';
};

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
    resetConvars();
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

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, true));
    expect(emitNet).toHaveBeenCalledWith(OPEN, SRC);
  });

  it('subscribes to player load, so a fresh character is told where it stands', async () => {
    const subscriber = loadedSubscribers.find((s) => s.name === 'phone-item');
    expect(subscriber).toBeDefined();

    await subscriber!.run(SRC);

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, true));
  });

  it('tells a holder they are gated and held, and a non-holder they are not held', async () => {
    bridgeMock.countItem.mockReturnValue(2);
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(bridgeMock.countItem).toHaveBeenCalledWith(PLAYER, 'phone');

    bridgeMock.countItem.mockReturnValue(0);
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: true, held: false });
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, false));
  });

  it('pushes "not gated" when the convar is empty, so the client stops relaying', async () => {
    convar.current = '';

    expect(phoneItemName()).toBeNull();
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(bridgeMock.countItem).not.toHaveBeenCalled();
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(false, true));
  });

  it('pushes nothing for a source with no loaded character', async () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);

    expect(await evaluatePhoneItem(SRC)).toBeNull();
    expect(emitNet).not.toHaveBeenCalled();
  });

  it('ignores the gate on a standalone server, and says so once', async () => {
    bridgeMock.framework = 'standalone';

    expect(phoneItemName()).toBeNull();
    expect(phoneItemName()).toBeNull();
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('standalone');
  });

  it('refuses a name no inventory would accept, and says so once', async () => {
    convar.current = "phone'; DROP TABLE";

    expect(phoneItemName()).toBeNull();
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: false, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not an item name');
  });

  it('fails open, loudly and once, when no inventory can count', async () => {
    bridgeMock.countItem.mockReturnValue(null);

    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(await evaluatePhoneItem(SRC)).toEqual({ gated: true, held: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('left open');
  });

  describe('the "look again" event', () => {
    it('counts and pushes for a loaded player', async () => {
      bridgeMock.countItem.mockReturnValue(0);

      netHandlers[CHECK]();
      await flush();

      expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, false));
    });

    it('is refused silently for a source with no loaded character', async () => {
      bridgeMock.getPlayer.mockReturnValue(undefined);

      netHandlers[CHECK]();
      await flush();

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
    resetConvars();
    bridgeMock.framework = 'qb';
    bridgeMock.getPlayer.mockReturnValue(PLAYER);
    bridgeMock.countItem.mockReturnValue(1);
    (globalThis as any).source = SRC;
  });

  it('tells a subscriber on load, on use, and on the look-again event', async () => {
    const run = vi.fn();
    onPhoneStateChanged('test-load-use-relay', run);

    await loadedSubscribers.find((s) => s.name === 'phone-item')!.run(SRC);
    registeredAtImport![1](SRC);
    netHandlers[CHECK]();
    await flush();

    expect(run.mock.calls).toEqual([[SRC], [SRC], [SRC]]);
  });

  it('tells nobody about a source with no loaded character', async () => {
    const run = vi.fn();
    onPhoneStateChanged('test-unloaded', run);
    bridgeMock.getPlayer.mockReturnValue(undefined);

    await evaluatePhoneItem(SRC);

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

    await evaluatePhoneItem(SRC);
    await Promise.resolve();

    expect(after).toHaveBeenCalledWith(SRC);
    const said = error.mock.calls.map((c) => String(c[0]));
    expect(said.some((line) => line.includes("'test-throws' threw"))).toBe(true);
    expect(said.some((line) => line.includes("'test-rejects' rejected"))).toBe(true);
    error.mockRestore();
  });
});

/**
 * MICA-263: the tablet is a second device with its own enable convar and its own item gate,
 * and neither may move the phone's. The module was imported with `mica_tablet` off, which is
 * the default install.
 */
describe('every device, one push each (MICA-263)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPhoneItemWarnings();
    __resetRateLimits();
    resetConvars();
    bridgeMock.framework = 'qb';
    bridgeMock.getPlayer.mockReturnValue(PLAYER);
    bridgeMock.countItem.mockReturnValue(1);
    (globalThis as any).source = SRC;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('reads the convar names shared/devices.ts declares, for every device', () => {
    for (const device of ALL_DEVICES) {
      expect(DEVICE_CONVARS[device]).toEqual(DEVICES[device].convars);
    }
  });

  it('registers no tablet item while mica_tablet is off, which is the default', () => {
    expect(registrationsAtImport.map(([item]) => item)).toEqual(['phone']);
    expect(isDeviceEnabled('tablet')).toBe(false);
    expect(enabledDevices()).toEqual(['phone']);
  });

  it('keeps an off tablet shut and uncounted, however its item convar reads', async () => {
    bridgeMock.countItem.mockReturnValue(0);

    const states = await evaluateDeviceItems(SRC);

    expect(states).toEqual([phone(true, false), TABLET_OFF]);
    expect(bridgeMock.countItem).toHaveBeenCalledTimes(1);
    expect(bridgeMock.countItem).toHaveBeenCalledWith(PLAYER, 'phone');
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, TABLET_OFF);
    expect(emitNet).toHaveBeenCalledWith(SERVER_ENABLED, SRC, { device: 'tablet', enabled: false });
  });

  it('never sends the phone a server-enabled push: it has no enable convar', async () => {
    convar.tablet = 'true';
    await evaluateDeviceItems(SRC);

    const enabledPushes = emitNet.mock.calls.filter(([event]) => event === SERVER_ENABLED);
    expect(enabledPushes).toEqual([[SERVER_ENABLED, SRC, { device: 'tablet', enabled: true }]]);
  });

  it.each(['1', 'true', 'TRUE', ' on ', 'yes', 'enabled'])('reads mica_tablet %j as on', (raw) => {
    convar.tablet = raw;
    expect(isDeviceEnabled('tablet')).toBe(true);
    expect(enabledDevices()).toEqual(['phone', 'tablet']);
  });

  it.each(['', '0', 'false', 'off', 'nope'])('reads mica_tablet %j as off', (raw) => {
    convar.tablet = raw;
    expect(enabledDevices()).toEqual(['phone']);
  });

  it('gates the tablet on its own item, independently of the phone', async () => {
    convar.tablet = 'true';
    bridgeMock.countItem.mockImplementation((_player: unknown, item: string) =>
      item === 'phone' ? 1 : 0
    );

    expect(await evaluateDeviceItems(SRC)).toEqual([
      phone(true, true),
      { device: 'tablet', enabled: true, gated: true, held: false }
    ]);

    bridgeMock.countItem.mockImplementation((_player: unknown, item: string) =>
      item === 'phone' ? 0 : 1
    );

    expect(await evaluateDeviceItems(SRC)).toEqual([
      phone(true, false),
      { device: 'tablet', enabled: true, gated: true, held: true }
    ]);
  });

  it('leaves the tablet ungated when only the phone is gated, and the reverse', async () => {
    convar.tablet = 'true';
    convar.tabletItem = '';
    expect((await evaluateDeviceItems(SRC))?.[1]).toEqual({
      device: 'tablet',
      enabled: true,
      gated: false,
      held: true
    });

    convar.current = '';
    convar.tabletItem = 'tablet';
    bridgeMock.countItem.mockReturnValue(0);
    expect(await evaluateDeviceItems(SRC)).toEqual([
      phone(false, true),
      { device: 'tablet', enabled: true, gated: true, held: false }
    ]);
    expect(phoneItemName()).toBeNull();
  });

  it('ignores every item gate on a standalone server, but still honours mica_tablet', async () => {
    bridgeMock.framework = 'standalone';
    convar.tablet = 'true';

    expect(await evaluateDeviceItems(SRC)).toEqual([
      phone(false, true),
      { device: 'tablet', enabled: true, gated: false, held: true }
    ]);
    expect(bridgeMock.countItem).not.toHaveBeenCalled();

    convar.tablet = 'false';
    expect(enabledDevices()).toEqual(['phone']);
  });

  it('refuses a tablet item name no inventory would accept, naming its own convar', () => {
    convar.tablet = 'true';
    convar.tabletItem = 'tab let';

    expect(deviceItemName('tablet')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('mica_tablet_item');
    expect(deviceItemName('phone')).toBe('phone');
  });

  it('tells the phone-state subscribers once per pass, not once per device', async () => {
    convar.tablet = 'true';
    const run = vi.fn();
    onPhoneStateChanged('test-once-per-pass', run);

    netHandlers[CHECK]();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(emitNet.mock.calls.filter(([event]) => event === PUSH)).toHaveLength(2);
  });

  it('opens the same phone from any slot, and keeps no slot (MICA-438)', () => {
    registeredAtImport![1](SRC, { slot: 4 });
    registeredAtImport![1](SRC, { slot: 6 });
    registeredAtImport![1](SRC);

    // Every copy is a key to the same phone: a use from another slot is no switch.
    expect(emitNet.mock.calls.filter(([event]) => event === OPEN)).toEqual([
      [OPEN, SRC],
      [OPEN, SRC],
      [OPEN, SRC]
    ]);
    expect(loadedForgetters.map(({ name }) => name)).not.toContain('device-last-used');
  });

  it('tells the device-state subscribers about every device but the phone, once a pass', async () => {
    const seen: unknown[][] = [];
    onDeviceStateChanged('test-device-pass', (src, device) => {
      seen.push([src, device]);
    });

    netHandlers[CHECK]();
    await flush();
    // On or off: an off tablet is told too, so its cached id is cleared.
    expect(seen).toEqual([[SRC, 'tablet']]);

    // A phone use is the phone-state hook's, not this one's.
    seen.length = 0;
    registeredAtImport![1](SRC, { slot: 4 });
    expect(seen).toEqual([]);
  });

  it('keeps a device-state subscriber that throws from stopping the pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    onDeviceStateChanged('test-throws', () => {
      throw new Error('boom');
    });
    onDeviceStateChanged('test-after-throw', after);

    expect(() => netHandlers[CHECK]()).not.toThrow();
    await flush();
    expect(after).toHaveBeenCalledWith(SRC, 'tablet');
    expect(error.mock.calls.some(([line]) => String(line).includes("'test-throws'"))).toBe(true);
    error.mockRestore();
  });

  it('turns the tablet on when mica_tablet is unset, since MICA-264 gave it an identity', () => {
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_tablet' ? fallback : previous(name, fallback);
    try {
      expect(isDeviceEnabled('tablet')).toBe(true);
      expect(enabledDevices()).toEqual(['phone', 'tablet']);
    } finally {
      (globalThis as any).GetConvar = previous;
    }
  });
});

/**
 * MICA-438: a phone item is a key, not a phone. Whichever copy a player holds opens their own
 * phone, so the gate is a count and nothing else — no slot is read, no row, no metadata — and it
 * answers in the same tick it is asked.
 */
describe('any copy is a key (MICA-438)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPhoneItemWarnings();
    __resetRateLimits();
    resetConvars();
    bridgeMock.framework = 'qb';
    bridgeMock.getPlayer.mockReturnValue(PLAYER);
    (globalThis as any).source = SRC;
  });

  it('pushes held by count from checkDeviceItem, in the same tick, and pushes not held for none', () => {
    bridgeMock.countItem.mockReturnValue(3);
    netHandlers[CHECK]();
    // No flush: the pass is synchronous, so the push is already out.
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, true));

    emitNet.mockClear();
    bridgeMock.countItem.mockReturnValue(0);
    netHandlers[CHECK]();
    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, false));
    expect(emitNet).not.toHaveBeenCalledWith(PUSH, SRC, phone(true, true));
  });

  it('asks the inventory for a count and for nothing else', () => {
    bridgeMock.countItem.mockReturnValue(1);
    expect(holdsDevice(PLAYER as any, 'phone')).toBe(true);
    evaluateDeviceItems(SRC);
    // The bridge mock has no slot reader at all, so a read of one would have thrown above; the
    // count is asked once per question, with the player and the item.
    expect(bridgeMock.countItem.mock.calls).toEqual([
      [PLAYER, 'phone'],
      [PLAYER, 'phone']
    ]);
  });

  it('answers a synchronous caller the count it pushes', () => {
    bridgeMock.countItem.mockReturnValue(0);
    expect(holdsDevice(PLAYER as any, 'phone')).toBe(false);
    bridgeMock.countItem.mockReturnValue(1);
    expect(holdsDevice(PLAYER as any, 'phone')).toBe(true);
  });

  it('opens on any use in the same tick, and tells the phone-state subscribers', () => {
    const run = vi.fn();
    onPhoneStateChanged('test-any-copy', run);

    registeredAtImport![1](SRC, { slot: 9 });

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, phone(true, true));
    expect(emitNet).toHaveBeenCalledWith(OPEN, SRC);
    expect(run).toHaveBeenCalledWith(SRC);
  });
});

/**
 * The same module loaded again with the tablet switched on, so its usable item registers.
 * A fresh import rather than toggling the convar, because registration is read once, at
 * resource start, exactly as a server would.
 */
describe('a server with mica_tablet on (MICA-263)', () => {
  const importWithTablet = async (tabletItem: string, battery = 'battery_bank') => {
    vi.resetModules();
    vi.clearAllMocks();
    convar.current = 'phone';
    convar.tablet = 'true';
    convar.tabletItem = tabletItem;
    convar.battery = battery;
    bridgeMock.framework = 'qb';
    const mod = await import('../lib/deviceItem');
    const registered = [...bridgeMock.registerUsableItem.mock.calls] as [
      string,
      (source: number, used?: { slot?: unknown }) => void
    ][];
    return { mod, registered };
  };

  afterEach(() => {
    resetConvars();
  });

  it('registers the tablet item beside the phone one', async () => {
    const { registered, mod } = await importWithTablet('tablet');

    expect(registered.map(([item]) => item)).toEqual(['phone', 'tablet']);
    expect(mod.enabledDevices()).toEqual(['phone', 'tablet']);
  });

  it("opens the tablet on use and touches nothing of the phone's identity", async () => {
    const { registered, mod } = await importWithTablet('tablet');
    const subscriber = vi.fn();
    mod.onPhoneStateChanged('test-tablet-use', subscriber);
    const [, onUse] = registered.find(([item]) => item === 'tablet')!;

    onUse(SRC, { slot: 9 });
    onUse(SRC, { slot: 11 });

    expect(emitNet).toHaveBeenCalledWith(PUSH, SRC, {
      device: 'tablet',
      enabled: true,
      gated: true,
      held: true
    });
    expect(emitNet).toHaveBeenCalledWith(OPEN, SRC, { device: 'tablet' });
    // No phone-state subscriber, since those follow the phone's number and battery; and the
    // same open from either slot: every copy opens the same tablet (MICA-438).
    expect(subscriber).not.toHaveBeenCalled();
    expect(emitNet.mock.calls.filter(([event]) => event === OPEN)).toEqual([
      [OPEN, SRC, { device: 'tablet' }],
      [OPEN, SRC, { device: 'tablet' }]
    ]);
    expect(emitNet.mock.calls.some(([, , p]) => (p as any)?.device === 'phone')).toBe(false);
    expect(emitNet).not.toHaveBeenCalledWith(OPEN, SRC);
  });

  it('tells the device-state subscribers on a tablet use, so its id follows (MICA-264)', async () => {
    const { registered, mod } = await importWithTablet('tablet');
    const seen: unknown[][] = [];
    mod.onDeviceStateChanged('test-tablet-use', (src, device) => {
      seen.push([src, device]);
    });

    registered.find(([item]) => item === 'tablet')![1](SRC, { slot: 9 });

    expect(seen).toEqual([[SRC, 'tablet']]);
  });

  it('does not let one item be both, and keeps it for the phone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registered } = await importWithTablet('phone');

    expect(registered.map(([item]) => item)).toEqual(['phone']);
    const said = warn.mock.calls.map(([line]) => String(line));
    expect(said.some((line) => line.includes('mica_phone_item') && line.includes('both'))).toBe(
      true
    );
    warn.mockRestore();
  });

  it('refuses a tablet item that is the battery bank, which registers after it and would win', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registered } = await importWithTablet('battery_bank');

    expect(registered.map(([item]) => item)).toEqual(['phone']);
    const said = warn.mock.calls.map(([line]) => String(line));
    expect(said.some((line) => line.includes('mica_battery_item') && line.includes('both'))).toBe(
      true
    );
    warn.mockRestore();
  });

  it('follows mica_battery_item rather than its default, and registers a tablet it frees', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await importWithTablet('powerbank', 'powerbank')).registered.map(([i]) => i)).toEqual([
      'phone'
    ]);
    expect((await importWithTablet('battery_bank', '')).registered.map(([i]) => i)).toEqual([
      'phone',
      'battery_bank'
    ]);
    warn.mockRestore();
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
