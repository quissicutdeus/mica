import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * MICA-136, and the registry that stopped it happening a fourth time.
 *
 * `QBCore:Server:OnPlayerLoaded` is registered with `onNet` rather than `on`, because qbx_core
 * fires it from the *client* with `TriggerServerEvent` and no payload
 * (`qbx_core/client/character.lua:280` and `:482`; see the comment in `lib/shell.ts`). `onNet`
 * is what makes it reachable by **any** connected client.
 *
 * There were three listeners for it — `lib/shell.ts`, `services/Settings.ts` and
 * `services/Battery.ts` — each pasted from the last, and all three took the target straight
 * out of the payload: the only place in the resource where a payload named somebody else and
 * was believed. MICA-136 fixed it in three files at once because the mistake had been made
 * in three files at once, and adding ESX (MICA-150) would have meant a fourth listener per
 * module.
 *
 * So `lib/shell.ts` now owns every player-loaded entry point and the other two subscribe.
 * Three properties are asserted here, and the first is the one that makes the other two stay
 * true: **no file but `lib/shell.ts` may register a player-loaded event at all**, checked
 * against the source tree rather than against what this suite happens to import. Then: the
 * resolved source never comes from a payload on the network path, and a subscriber cannot see
 * an id the connection did not supply.
 */
const { dbMock, bridgeMock, handlers, networked, framework } = vi.hoisted(() => {
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
    /**
     * Which framework the bridge is answering for, as a mutable box.
     *
     * `lib/shell.ts` asks `detectFramework()` on the standalone path and nowhere else — that
     * listener is registered on a name the FiveM *runtime* raises for every join on every
     * server, so the verdict is the only thing keeping it from dispatching a second time
     * alongside a framework's own event.
     */
    framework: { kind: 'qb' as string },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => framework.kind
}));

import { loadedPlayerSource, onPlayerLoaded, PLAYER_LOADED_EVENTS } from '../lib/shell';
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
  framework.kind = 'qb';
});

describe('the network player-loaded listeners', () => {
  it('registers exactly one listener over the network', () => {
    // Three, once — one per module, each pasted from the last, and all three took the target
    // out of the payload. `lib/shell.ts` now owns the entry point and `Settings`/`Battery`
    // subscribe. The count is asserted rather than `toBeGreaterThan(0)` because a second
    // registration means somebody hand-wrote a listener again, and the whole class of bug
    // MICA-136 fixed is a hand-written listener resolving its own identity.
    expect(loadedListeners()).toHaveLength(1);
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
/**
 * The guard that makes the fragility structural rather than documented.
 *
 * Counting registrations only catches a listener in a module this suite happens to import, so
 * a fifth module registering its own would slip past. This reads the source tree instead: no
 * file but `lib/shell.ts` may register **any** player-loaded event name, whichever registrar
 * it uses. Adding a listener the old way now fails the build, which is the difference between
 * a rule and a comment — a guard that cannot fail is not a guard.
 *
 * Prose is deliberately allowed. `netGuard.ts` and `docs/security.md` both name these events
 * in comments and should keep doing so; only a registration call is refused.
 */
describe('nothing outside lib/shell.ts registers a player-loaded event', () => {
  const serverDir = path.join(__dirname, '..');

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });

  /** `on('name'` or `onNet('name'`, in either quote style, with or without whitespace. */
  const registrationOf = (event: string) =>
    new RegExp(String.raw`\bon(?:Net)?\(\s*['"]${event}['"]`);

  it.each(Object.entries(PLAYER_LOADED_EVENTS))(
    '%s (%s) is registered nowhere else',
    (_key, event) => {
      const registration = registrationOf(event);

      const offenders = sourceFiles(serverDir)
        .map((file) => path.relative(serverDir, file))
        .filter((file) => file !== path.join('lib', 'shell.ts'))
        .filter((file) => registration.test(fs.readFileSync(path.join(serverDir, file), 'utf8')));

      expect(
        offenders,
        `'${event}' must only be registered in lib/shell.ts, which resolves the identity and ` +
          'dispatches to subscribers. Use `onPlayerLoaded(name, handler)` instead — a ' +
          'hand-written listener has to resolve the target itself, and that is what ' +
          'MICA-136 had to fix in three files at once.'
      ).toEqual([]);
    }
  );

  it.each(Object.entries(PLAYER_LOADED_EVENTS))(
    '%s (%s) has a pattern that still bites',
    (_key, event) => {
      /**
       * The scan above is an emptiness assertion, so a pattern that stopped matching anything
       * would pass it forever while guarding nothing — the "a check that fails open reads as a
       * pass" failure this repo cares about, and the reason `lib/shell.ts` registers through
       * `PLAYER_LOADED_EVENTS` rather than literals (so the scan cannot anchor on shell's own
       * line). These are the shapes an offender would actually be written in.
       */
      const registration = registrationOf(event);

      for (const offending of [
        `on('${event}', (player) => {})`,
        `onNet('${event}', (player) => {})`,
        `on("${event}", handler)`,
        `onNet( '${event}', handler )`
      ]) {
        expect(registration.test(offending), `should have matched: ${offending}`).toBe(true);
      }

      // And prose naming the event — which `netGuard.ts` and `docs/security.md` both do, and
      // should keep doing — is not an offence.
      expect(registration.test(`// see the ${event} listener in lib/shell.ts`)).toBe(false);
    }
  );
});

/**
 * The registry, and the property that the two identity paths stay separate.
 */
describe('the player-loaded registry', () => {
  it('runs every subscriber for one resolved source', () => {
    // Shell, settings and battery all subscribe; one event feeds all three.
    for (const listener of loadedListeners()) listener(undefined);

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
  });

  it('keeps running the others when one subscriber throws', async () => {
    // A broken subscriber degrades rather than taking the character load with it — gPhone has
    // no way to fail a framework's player load and must not invent one.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onPlayerLoaded('exploding', () => {
      throw new Error('subscriber exploded');
    });

    expect(() => {
      for (const listener of loadedListeners()) listener(undefined);
    }).not.toThrow();

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    await vi.waitFor(() =>
      expect(emitted()).toContainEqual(['gphone:client:battery:set', ATTACKER, 100])
    );
  });

  it('names the subscriber that threw, rather than failing silently', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onPlayerLoaded('noisy', () => {
      throw new Error('subscriber exploded');
    });

    for (const listener of loadedListeners()) listener(undefined);

    expect(error.mock.calls.some((call) => String(call[0]).includes('noisy'))).toBe(true);
  });

  it('catches a rejected async subscriber too', async () => {
    // `Battery`'s subscriber is async. A `void`-ed rejection would otherwise surface as an
    // unhandled rejection with nothing naming the subscriber.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onPlayerLoaded('async-boom', () => Promise.reject(new Error('later')));

    for (const listener of loadedListeners()) listener(undefined);

    await vi.waitFor(() =>
      expect(error.mock.calls.some((call) => String(call[0]).includes('async-boom'))).toBe(true)
    );
  });

  it('never reaches a subscriber with a source the connection did not supply', () => {
    // The MICA-136 property, now asserted one layer further in: the registry is handed an
    // already-resolved source, so a forged payload is refused before any subscriber sees it.
    onPlayerLoaded('watcher', (src) => {
      throw new Error(`should not have run for ${src}`);
    });

    for (const listener of loadedListeners()) listener({ PlayerData: { source: VICTIM } });

    expect(emitted()).toHaveLength(0);
  });
});

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

  it('reaches settings and battery too, through the one registry', () => {
    // The gap this closes: `Settings.ts` and `Battery.ts` used to register their own qb-named
    // listeners, so an ESX character load rehydrated the shell and nothing else — a player
    // whose saved charge was 12 saw 100. They subscribe now, so ESX costs them no code and
    // cannot be forgotten for the next framework either.
    for (const listener of esxListeners()) listener(ATTACKER, { source: ATTACKER });

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
    return vi.waitFor(() =>
      expect(emitted()).toContainEqual(['gphone:client:battery:set', ATTACKER, 100])
    );
  });
});

/**
 * Standalone's player-loaded path (MICA-151), which is not a player-loaded event at all.
 *
 * A standalone server has no framework, so nothing ever announces that a character loaded and
 * the three listeners above never fire again for the life of the resource. What does happen is
 * that somebody connects — and on a standalone server that *is* the whole of the event, since
 * one connection is one identity, resolved from the player's license.
 *
 * `playerJoining` is raised by the FiveM runtime itself, locally, when a connecting client is
 * assigned a server id. Two properties are asserted, and they are the two that make this safe:
 * it is not reachable over the network, and it reads the connection rather than its argument —
 * which is the joining player's *old* id from a server transfer, and is not an identity.
 */
describe("standalone's player-loaded path", () => {
  const joinListeners = (): Function[] => handlers.get('playerJoining') ?? [];

  beforeEach(() => {
    framework.kind = 'standalone';
  });

  it('is registered locally and is not reachable over the network', () => {
    // The property that fails the moment somebody adds an `onNet` twin "to be safe" and
    // manufactures a client-reachable entry point the runtime does not have.
    expect(joinListeners()).toHaveLength(1);
    expect(networked.has('playerJoining')).toBe(false);
    // For contrast, and to prove the harness can tell the two apart at all.
    expect(networked.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
  });

  it('dispatches for the connection when the server is standalone', () => {
    for (const listener of joinListeners()) listener();

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted()).toContainEqual(['gphone:client:settings:rehydrate', ATTACKER]);
  });

  it('reaches settings and battery too, through the one registry', async () => {
    for (const listener of joinListeners()) listener();

    await vi.waitFor(() =>
      expect(emitted()).toContainEqual(['gphone:client:battery:set', ATTACKER, 100])
    );
  });

  it("ignores the argument entirely — it is the player's old id, not an identity", () => {
    // MICA-136's rule, and here it costs nothing: the connection is the only thing on
    // offer, so it cannot be forgotten in favour of a payload.
    for (const listener of joinListeners()) listener(VICTIM);

    expect(emitted()).toContainEqual(['gphone:client:shell:rehydrate', ATTACKER]);
    expect(emitted().some((call) => call[1] === VICTIM)).toBe(false);
  });

  it('does nothing on a framework server, whose own event dispatches instead', () => {
    // `playerJoining` fires for every join on every server. Without the verdict gate this
    // would rehydrate a phone whose character has not loaded yet, and then again when it has.
    for (const kind of ['qb', 'esx', 'unknown']) {
      framework.kind = kind;
      for (const listener of joinListeners()) listener();
    }

    expect(emitted()).toHaveLength(0);
  });

  it('refuses a trigger with no connection behind it', () => {
    // `source` 0 is the console, or a local trigger that carried nothing.
    (globalThis as any).source = 0;

    for (const listener of joinListeners()) listener();

    expect(emitted()).toHaveLength(0);
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
