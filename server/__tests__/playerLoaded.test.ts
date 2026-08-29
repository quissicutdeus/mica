import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-136 — the three `QBCore:Server:OnPlayerLoaded` listeners.
 *
 * `server/lib/shell.ts`, `server/services/Settings.ts` and `server/services/Battery.ts`
 * each register this name with `onNet` rather than `on`, because qbx_core fires it from the
 * client with `TriggerServerEvent` and no payload (`qbx_core/client/character.lua:280` and
 * `:482`; see the comment in `lib/shell.ts`). `onNet` is what makes it reachable by *any*
 * connected client, and all three used to take the target straight out of the payload — the
 * only place in the resource where a payload named somebody else and was believed.
 *
 * All three now go through `loadedPlayerSource`, so they are tested together: the property
 * is that no listener for this event ever acts on an id the connection did not supply.
 * `battery.test.ts`, `settings.test.ts` and `shell.test.ts` each keep their own
 * per-listener coverage; this suite is the one that would notice a fourth listener being
 * added without the guard.
 */
const { dbMock, bridgeMock, handlers, networked } = vi.hoisted(() => {
  // Inside `vi.hoisted` because ESM evaluates imports first: all three modules register at
  // module scope, so a plain assignment below the imports would capture nothing.
  // A list per event, not a single handler: three modules answer to this one name and a
  // `Map<string, Function>` would silently keep only the last of them.
  const captured = new Map<string, Function[]>();
  const overNet = new Set<string>();
  const capture = (event: string, handler: Function) => {
    const list = captured.get(event) ?? [];
    list.push(handler);
    captured.set(event, list);
  };
  (globalThis as any).on = capture;
  // Recorded separately, because which registrar a name went through *is* the security
  // property here: `onNet` declares the name net-safe inside gPhone and makes it reachable by
  // any connected client, and `on` does not. MICA-150 added an ESX listener that must stay
  // on the `on` side, and nothing could tell the difference while both wrote to one map.
  (globalThis as any).onNet = (event: string, handler: Function) => {
    overNet.add(event);
    capture(event, handler);
  };

  return {
    networked: overNet,
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

/**
 * Fire the real `playerDropped` cleanup for every id this suite uses.
 *
 * `lib/shell.ts` remembers which connections it has already warned about, so a test that
 * refused earlier would otherwise silence the next one. Draining it through the handler the
 * resource actually registers, rather than a reset seam, means the cleanup itself is under
 * test on every run.
 */
const dropEveryone = () => {
  const previous = (globalThis as any).source;
  for (const dropped of [ATTACKER, VICTIM, GHOST]) {
    (globalThis as any).source = dropped;
    for (const handler of handlers.get('playerDropped') ?? []) handler();
  }
  (globalThis as any).source = previous;
};

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
  dropEveryone();
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

  it('still serves qbx_core, which sends no payload at all', async () => {
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

/**
 * MICA-136 follow-up: a refusal nobody can see.
 *
 * `guardNetEvent` refuses silently by design — no callback id, so nobody is waiting to be
 * told. Under stock qbx_core the ordering holds and it never refuses. Under a custom
 * multichar, or a core that announces a character before the framework has registered it,
 * gPhone would never rehydrate settings and never load battery, with no output anywhere and
 * this whole file still green: silence that reads as success.
 */
describe('a refusal that nobody would otherwise notice', () => {
  const warnings = () => vi.spyOn(console, 'warn').mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('names the connection and the reason when there is no character behind it', () => {
    bridgeMock.getPlayer.mockReturnValue(null);

    expect(loadedPlayerSource(undefined)).toBeUndefined();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('QBCore:Server:OnPlayerLoaded');
    expect(warnings()[0]).toContain(String(ATTACKER));
  });

  it('names the id a forged payload claimed', () => {
    expect(loadedPlayerSource({ PlayerData: { source: VICTIM } })).toBeUndefined();

    expect(warnings()[0]).toContain(String(VICTIM));
  });

  it('says it once per connection, so a flood cannot grow the log without bound', () => {
    // The reason `guardNetEvent` is silent in the first place: a line per packet is a log
    // an attacker writes as much of as they like.
    bridgeMock.getPlayer.mockReturnValue(null);

    for (let i = 0; i < 50; i++) loadedPlayerSource(undefined);

    expect(warnings()).toHaveLength(1);
  });

  it('forgets a dropped connection, so the next player on that id is not silenced', () => {
    // FiveM recycles server ids — the same reason `rateLimit.forgetSource` exists. A
    // remembered id would turn a real problem for the next player into no output at all.
    bridgeMock.getPlayer.mockReturnValue(null);
    loadedPlayerSource(undefined);
    expect(warnings()).toHaveLength(1);

    dropEveryone();
    loadedPlayerSource(undefined);

    expect(warnings()).toHaveLength(2);
  });

  it('stays quiet when the event is honest', () => {
    expect(loadedPlayerSource(undefined)).toBe(ATTACKER);

    expect(warnings()).toEqual([]);
  });
});

/**
 * ESX's player-loaded path (MICA-150), and why it looks nothing like the three above.
 *
 * es_extended fires `TriggerEvent('esx:playerLoaded', playerId, xPlayer, isNew)` — server-side
 * and **local**. It is not a `TriggerServerEvent`, which is the entire reason qbx's
 * `QBCore:Server:OnPlayerLoaded` had to be `onNet` and then had to be hardened by MICA-136.
 *
 * So the property asserted here is stronger than "the guard refuses a forged target": there is
 * no way in for a packet to be refused. gPhone registers this name with `on` only, and
 * `RegisterNetEvent`'s net-safety flag is per-resource, so the name is not net-safe inside
 * gPhone and a client emitting it reaches nothing. The first test below is the one that
 * matters — it fails the moment somebody adds an `onNet` twin "to be safe" and quietly
 * manufactures the client-reachable entry point es_extended does not have.
 */
describe("ESX's player-loaded event", () => {
  const esxListeners = (): Function[] => handlers.get('esx:playerLoaded') ?? [];

  it('is registered locally and is not reachable over the network', () => {
    expect(esxListeners()).toHaveLength(1);
    expect(networked.has('esx:playerLoaded')).toBe(false);
    // For contrast, and to prove the harness can tell the two apart at all.
    expect(networked.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
  });

  it('rehydrates the shell for the player id ESX names', () => {
    // The payload is the identity here on the same terms as the `QBCore:Server:PlayerLoaded`
    // local twin: no connection to derive one from, and no client able to reach it.
    for (const listener of esxListeners()) listener(VICTIM, { source: VICTIM });

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', VICTIM]);
  });

  it('falls back to the xPlayer source when the first argument is not an id', () => {
    // An ESX fork that reorders or drops the id should degrade to working rather than to
    // silence, which is the failure mode this whole file exists to catch.
    for (const listener of esxListeners()) listener(undefined, { source: ATTACKER });

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
  });

  it('does nothing when neither argument carries a source', () => {
    for (const listener of esxListeners()) listener(undefined, undefined);
    expect(emitted()).toHaveLength(0);
  });

  it('does not yet reach the settings and battery listeners — the known ESX gap', () => {
    // `server/services/Settings.ts` and `server/services/Battery.ts` register their own
    // player-loaded listeners and both still answer only to the qb event name. On ESX that
    // means no settings rehydrate and no battery seed on character load: the phone works, but
    // shows 100% for a player whose saved charge is 12. Pinned as a fact rather than left to
    // be discovered in game, and deliberately not fixed here — MICA-150's server lane is
    // scoped out of `server/services/`.
    for (const listener of esxListeners()) listener(ATTACKER, { source: ATTACKER });

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).not.toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
    expect(emitted().some((call) => call[0] === 'gphone:client:battery:set')).toBe(false);
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
