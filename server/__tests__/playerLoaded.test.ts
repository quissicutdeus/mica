import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-136 — the three `QBCore:Server:OnPlayerLoaded` listeners.
 *
 * `server/lib/shell.ts`, `server/services/Settings.ts` and `server/services/Battery.ts`
 * each register this name with `onNet` rather than `on`, because qbx_core's compat shim
 * fires it over the network (see the comment in `lib/shell.ts`). `onNet` is what makes it
 * reachable by *any* connected client, and all three used to take the target straight out
 * of the payload — the only place in the resource where a payload named somebody else and
 * was believed.
 *
 * All three now go through `loadedPlayerSource`, so they are tested together: the property
 * is that no listener for this event ever acts on an id the connection did not supply.
 * `battery.test.ts`, `settings.test.ts` and `shell.test.ts` each keep their own
 * per-listener coverage; this suite is the one that would notice a fourth listener being
 * added without the guard.
 */
const { dbMock, bridgeMock, handlers } = vi.hoisted(() => {
  // Inside `vi.hoisted` because ESM evaluates imports first: all three modules register at
  // module scope, so a plain assignment below the imports would capture nothing.
  // A list per event, not a single handler: three modules answer to this one name and a
  // `Map<string, Function>` would silently keep only the last of them.
  const captured = new Map<string, Function[]>();
  const capture = (event: string, handler: Function) => {
    const list = captured.get(event) ?? [];
    list.push(handler);
    captured.set(event, list);
  };
  (globalThis as any).on = capture;
  (globalThis as any).onNet = capture;

  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    bridgeMock: {
      getPlayer: vi.fn(),
      getCitizenId: vi.fn(),
      registerUsableItem: vi.fn()
    },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import { loadedPlayerSource } from '../lib/shell';
import { __resetBatteryCache } from '../services/Battery';
import '../services/Settings';
import { __resetRateLimits } from '../lib/rateLimit';

/** The client actually holding the connection the event arrived on. */
const ATTACKER = 7;
/** Somebody else entirely, named only by the payload. */
const VICTIM = 9;
/** A server id nobody is connected as. */
const GHOST = 4242;

const loadedListeners = (): Function[] => handlers.get('QBCore:Server:OnPlayerLoaded') ?? [];

const emitted = () => (globalThis.emitNet as any).mock.calls as unknown[][];

const asPlayer = (src: number) => ({
  citizenid: `CID${src}`,
  source: src,
  phone: null,
  setMeta: vi.fn(),
  removeItem: vi.fn(),
  rawPlayer: { PlayerData: { metadata: {} } }
});

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.emitNet = vi.fn() as any;
  (globalThis as any).source = ATTACKER;
  __resetRateLimits();
  __resetBatteryCache();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  // Everyone who asks is loaded, unless a test says otherwise. The interesting refusals
  // are about *which* id gets asked about, not about the framework being empty.
  bridgeMock.getPlayer.mockImplementation((src: number) => asPlayer(src));
});

describe('the network player-loaded listeners', () => {
  it('registers exactly the three known listeners over the network', () => {
    // If this number changes, the new listener needs `loadedPlayerSource` too — that is
    // the whole reason the count is asserted rather than `toBeGreaterThan(0)`.
    expect(loadedListeners()).toHaveLength(3);
  });

  it('ignores a payload naming a third party', () => {
    for (const listener of loadedListeners()) {
      listener({ PlayerData: { source: VICTIM } });
    }

    // Nothing reached the victim: no push, and no read of their row.
    expect(bridgeMock.getPlayer).not.toHaveBeenCalledWith(VICTIM);
    expect(emitted()).toHaveLength(0);
  });

  it('ignores a bare numeric payload naming a third party', () => {
    for (const listener of loadedListeners()) {
      listener(VICTIM);
    }

    expect(bridgeMock.getPlayer).not.toHaveBeenCalledWith(VICTIM);
    expect(emitted()).toHaveLength(0);
  });

  it('still serves the qbx_core compat shim, which sends no payload at all', async () => {
    for (const listener of loadedListeners()) {
      listener(undefined);
    }

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
    // Battery's load is async — the row read happens before the push.
    await vi.waitFor(() =>
      expect(emitted()).toContainEqual(['gphone:client:battery:set', ATTACKER, 100])
    );
  });

  it('still serves a payload that agrees with the connection', () => {
    for (const listener of loadedListeners()) {
      listener({ PlayerData: { source: ATTACKER } });
    }

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
  });

  it('never seeds battery state for an id that never connected', async () => {
    // The map entries `sendLoadedBatteryToClient` writes are only ever cleaned up by
    // `playerDropped`, which never fires for an id nobody is connected as — MICA-113/114
    // by a route those handlers do not see.
    bridgeMock.getPlayer.mockReturnValue(null);
    (globalThis as any).source = GHOST;

    for (const listener of loadedListeners()) {
      listener({ PlayerData: { source: GHOST } });
      listener(undefined);
    }

    await vi.waitFor(() => expect(emitted()).toHaveLength(0));
  });
});

describe('loadedPlayerSource', () => {
  it('resolves the connection when the payload is empty', () => {
    expect(loadedPlayerSource(undefined)).toBe(ATTACKER);
  });

  it('resolves the connection when the payload agrees with it', () => {
    expect(loadedPlayerSource({ PlayerData: { source: ATTACKER } })).toBe(ATTACKER);
  });

  it('refuses a payload that disagrees with the connection', () => {
    expect(loadedPlayerSource({ PlayerData: { source: VICTIM } })).toBeUndefined();
  });

  it('refuses a local trigger with no connection behind it', () => {
    // `source` 0 is the console, or a local `TriggerEvent` that carried nothing. The
    // local twins listen on `on('QBCore:Server:PlayerLoaded')` and are unaffected.
    (globalThis as any).source = 0;
    expect(loadedPlayerSource({ PlayerData: { source: VICTIM } })).toBeUndefined();
    expect(loadedPlayerSource(undefined)).toBeUndefined();
  });

  it('refuses a connection with no loaded character', () => {
    bridgeMock.getPlayer.mockReturnValue(null);
    expect(loadedPlayerSource(undefined)).toBeUndefined();
  });

  it('rate limits, so one client cannot loop a database read per packet', () => {
    // 60 per minute per source per action, from `lib/rateLimit.ts`. The limiter was never
    // consulted on this path before: it keys on the caller, and the caller was not the
    // player being acted on.
    const accepted = Array.from({ length: 61 }, () => loadedPlayerSource(undefined)).filter(
      (src) => src !== undefined
    );

    expect(accepted).toHaveLength(60);
  });
});
