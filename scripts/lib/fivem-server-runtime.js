// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'fs';
import path from 'path';

/**
 * A stand-in for the FXServer JavaScript runtime, for `test-endpoints.js` (MICA-304).
 *
 * The real server bundle is imported against this and runs unmodified: it registers its net
 * events with `onNet`, its local listeners with `on`, its console commands with
 * `RegisterCommand` and its exports with `exports(name, fn)`, all into the maps below. The
 * harness then plays the parts nobody in this repo can play for real — the connecting clients,
 * the other resources calling exports, and the framework core on a qb server.
 *
 * **What is modelled, because the code under test depends on it:**
 *
 * - `source` is a global set for the synchronous part of a handler and put back afterwards,
 *   which is how FXServer delivers it. A handler that reads it after an `await` reads whatever
 *   the next event left there — in the game as here.
 * - A client can only reach an event some `onNet` registered (FiveM's net-safe flag). An
 *   event registered only with `on` is refused from a client, as `playerJoining` must be.
 * - Arguments cross the network as data: they are serialised on the way in and on the way out,
 *   so a handler cannot be handed, or hand back, a live object.
 * - `GetInvokingResource()` answers the calling resource only during the synchronous part of
 *   an export call and `null` once it has yielded — the property `publicApi.ts` is written
 *   around.
 * - Players are a table of sources, each with a name and a list of identifiers, read through
 *   the natives the standalone bridge uses (`GetPlayerIdentifierByType`, the numbered
 *   identifiers, `DoesPlayerExist`, `GetNumPlayerIndices`/`GetPlayerFromIndex`).
 *
 * **What is not:** the event loop's scheduling, msgpack's exact encoding, cross-resource
 * function references (an export handed a function gets the function), voice, entities and
 * coordinates (answered as nobody, nowhere), and anything a client does with what it is sent.
 */

/** A deep copy through JSON: the network carries data, not references. */
const wire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const createRuntime = ({ root, resourceName = 'mica', convars = {}, resources = {} }) => {
  /** event -> handlers, in registration order. */
  const handlers = new Map();
  /** Events a client may reach: those some `onNet` registered. */
  const netSafe = new Set();
  /** Every `emitNet`, in order: `{ event, target, args }`. */
  const sent = [];
  /** Every `RegisterCommand`. */
  const commands = new Map();
  /** Every `exports(name, fn)` this resource published. */
  const published = new Map();
  /** src -> { name, identifiers } */
  const players = new Map();
  /** Intervals, and timeouts with their delay, started while installed; `shutdown` clears both. */
  const intervals = new Set();
  const timeouts = new Map();
  const convarValues = { ...convars };
  let invoking = null;

  const register = (event, fn) => {
    if (typeof fn !== 'function') throw new Error(`a handler for '${event}' is not a function`);
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
  };

  /** Run every handler for `event` with `source` set to `src`, and wait for all of them. */
  const dispatch = async (src, event, args) => {
    const pending = [];
    for (const fn of handlers.get(event) ?? []) {
      const previous = globalThis.source;
      globalThis.source = src;
      try {
        pending.push(Promise.resolve(fn(...args)));
      } catch (error) {
        // FXServer logs a handler's throw and carries on with the next handler.
        console.error(`    [runtime] handler for ${event} threw:`, error);
      } finally {
        globalThis.source = previous;
      }
    }
    const settled = await Promise.allSettled(pending);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        console.error(`    [runtime] handler for ${event} rejected:`, outcome.reason);
      }
    }
    return pending.length;
  };

  const identifiersOf = (src) => players.get(Number(src))?.identifiers ?? [];

  const exportsFn = function exports(name, fn) {
    published.set(name, fn);
  };
  // `exports.oxmysql`, `exports['qb-core']`: another resource's exports, or undefined for a
  // resource that is not running. Read per access, so a shape can add or remove one.
  const exportsProxy = new Proxy(exportsFn, {
    get: (target, key) => (key in resources ? resources[key] : target[key])
  });

  const globals = {
    exports: exportsProxy,
    source: undefined,
    on: register,
    onNet: (event, fn) => {
      netSafe.add(event);
      register(event, fn);
    },
    emit: (event, ...args) => void dispatch(globalThis.source, event, args),
    TriggerEvent: (event, ...args) => void dispatch(globalThis.source, event, args),
    emitNet: (event, target, ...args) => {
      sent.push({ event, target: Number(target), args: wire(args) });
    },
    TriggerClientEvent: (event, target, ...args) => {
      sent.push({ event, target: Number(target), args: wire(args) });
    },
    RegisterCommand: (name, fn) => commands.set(name, fn),
    GetCurrentResourceName: () => resourceName,
    GetInvokingResource: () => invoking,
    GetResourceState: (name) =>
      name === resourceName || name in resources ? 'started' : 'missing',
    GetResourcePath: (name) => (name === resourceName ? root : ''),
    LoadResourceFile: (name, file) => {
      if (name !== resourceName) return null;
      const full = path.join(root, file);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    },
    GetConvar: (name, fallback) =>
      name in convarValues ? String(convarValues[name]) : String(fallback),
    GetConvarInt: (name, fallback) => {
      const parsed = Number.parseInt(convarValues[name], 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    IsPlayerAceAllowed: () => false,
    GetPlayerName: (src) => players.get(Number(src))?.name ?? null,
    DoesPlayerExist: (src) => players.has(Number(src)),
    GetPlayerIdentifierByType: (src, type) =>
      identifiersOf(src).find((id) => id.startsWith(`${type}:`)) ?? null,
    GetNumPlayerIdentifiers: (src) => identifiersOf(src).length,
    GetPlayerIdentifier: (src, index) => identifiersOf(src)[index] ?? null,
    GetNumPlayerIndices: () => players.size,
    GetPlayerFromIndex: (index) => String([...players.keys()].sort((a, b) => a - b)[index] ?? -1),
    GetPlayers: () => [...players.keys()].sort((a, b) => a - b).map(String),
    // Nobody, nowhere: no entity exists in a server with no clients.
    GetPlayerPed: () => 0,
    DoesEntityExist: () => false,
    GetEntityCoords: () => [0, 0, 0],
    GetEntityHealth: () => 0,
    GetPlayerRoutingBucket: () => 0
  };

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  return {
    sent,
    commands,
    published,
    players,
    netSafe,
    handlers,

    /** Put this runtime's globals in place. Before the bundle is imported. */
    install() {
      Object.assign(globalThis, globals);
      globalThis.setInterval = (fn, ms, ...rest) => {
        const handle = realSetInterval(fn, ms, ...rest);
        intervals.add(handle);
        return handle;
      };
      globalThis.clearInterval = (handle) => {
        intervals.delete(handle);
        realClearInterval(handle);
      };
      globalThis.setTimeout = (fn, ms, ...rest) => {
        const handle = realSetTimeout(
          (...args) => {
            timeouts.delete(handle);
            fn(...args);
          },
          ms,
          ...rest
        );
        timeouts.set(handle, Number(ms) || 0);
        return handle;
      };
      globalThis.clearTimeout = (handle) => {
        timeouts.delete(handle);
        realClearTimeout(handle);
      };
    },

    /**
     * Stop every interval and pending timeout started while installed — the bundle's sweeps,
     * tickers and grace periods — so the process can exit, and put the real timers back.
     */
    shutdown() {
      for (const handle of intervals) realClearInterval(handle);
      for (const handle of timeouts.keys()) realClearTimeout(handle);
      intervals.clear();
      timeouts.clear();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },

    /**
     * Whether a short timeout is pending: a handler yielding with `setTimeout(…, 0)` between
     * statements (`orphanSweep.ts`, `contentRetention.ts`) is still working, though no query
     * is in flight at that instant. Long ones — a grace period, a handler deadline — are
     * waits, not work.
     */
    shortTimerPending: () => [...timeouts.values()].some((ms) => ms <= 100),

    setConvar(name, value) {
      if (value === undefined) delete convarValues[name];
      else convarValues[name] = value;
    },

    /** Another resource, as `exports[name]` will answer it. Undefined removes it. */
    setResource(name, value) {
      if (value === undefined) delete resources[name];
      else resources[name] = value;
    },

    /** A client connects: the server id exists, with these identifiers. No event fires. */
    addPlayer(src, { name = `Player ${src}`, identifiers = [] } = {}) {
      players.set(src, { name, identifiers });
    },

    removePlayer(src) {
      players.delete(src);
    },

    /**
     * A runtime-raised event for one connection (`playerJoining`, `playerDropped`): FXServer
     * raises these in-process with `source` set to the player, so they reach `on` handlers and
     * no client can send them.
     */
    raise: (src, event, ...args) => dispatch(src, event, wire(args)),

    /** A resource-local `TriggerEvent`, with no player behind it. */
    local: (event, ...args) => dispatch('', event, wire(args)),

    /**
     * A client's `TriggerServerEvent`. Refused, as FXServer refuses it, when no `onNet`
     * registered the name. Answers how many handlers ran.
     */
    fire: async (src, event, ...args) => {
      if (!netSafe.has(event)) return 0;
      return await dispatch(src, event, wire(args));
    },

    /**
     * Another resource calling one of this resource's exports. The invoker is visible only
     * until the export first yields, exactly as `GetInvokingResource` behaves in game.
     */
    callExport: async (invoker, name, ...args) => {
      const fn = published.get(name);
      if (!fn) throw new Error(`export '${name}' was never published`);
      let result;
      invoking = invoker;
      try {
        result = fn(...args);
      } finally {
        invoking = null;
      }
      return await result;
    },

    /** Every `emitNet` since `mark`, optionally filtered. */
    since: (mark, filter = () => true) => sent.slice(mark).filter(filter)
  };
};
