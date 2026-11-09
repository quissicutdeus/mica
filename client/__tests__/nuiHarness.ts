// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The FiveM client runtime, stubbed whole, for `hostileNuiPayloads.test.ts` (MICA-466) and
 * `focusRelease.test.ts` (MICA-467).
 *
 * **Importing this module installs the stubs.** That is the point of it being a module rather
 * than a function a test calls: the suite imports it first and `../client` second, and ES
 * modules evaluate in import order, so every native exists before `client.ts` and everything
 * it pulls in touch one at module scope.
 *
 * Every native is generated from `@citizenfx/client`'s own declarations rather than listed,
 * so a module that starts calling a new one is loadable with no edit here. Each answers the
 * zero of its declared return type (`0`, `false`, `''`, a tuple of zeros) and is recorded
 * while a sweep case runs. Runtime functions that are not natives (`on`, `onNet`, `emitNet`,
 * `setTick`, `exports`) are written out below, because they are what the sweep captures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Where a recorded call went: to the server, into the game, or into another resource. */
export type SinkKind = 'server' | 'native' | 'export';

export interface SinkCall {
  kind: SinkKind;
  /** `emitNet`, a native's name, or `exports.<resource>.<method>`. */
  sink: string;
  args: unknown[];
}

export type NuiHandler = (data: unknown, cb: (...reply: unknown[]) => void) => unknown;

/** Every name passed to `RegisterNuiCallbackType`, in registration order, duplicates kept. */
export const registeredNuiTypes: string[] = [];
/** Every `on('__cfx_nui:<name>')` handler, by name, duplicates kept. */
export const nuiHandlers = new Map<string, NuiHandler[]>();
/** Every `onNet` handler, by event name, duplicates kept (MICA-467). */
export const netHandlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
/** Every `RegisterCommand` handler, by command name (MICA-467). */
export const commands = new Map<string, (...args: unknown[]) => unknown>();
/** Every native `@citizenfx/client` declares, so a suite can wrap them all (MICA-467). */
export const nativeNames: string[] = [];

/** The calls recorded since the current case began, or null between cases. */
let recording: SinkCall[] | null = null;
const record = (call: SinkCall): void => {
  recording?.push(call);
};

const g = globalThis as Record<string, unknown>;

/** A value of a declared native return type: what a native that did nothing would answer. */
const zeroOf = (type: string): (() => unknown) => {
  const t = type.replace(/\/\*.*?\*\//g, '').trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const parts = t
      .slice(1, -1)
      .split(',')
      .map((p) => zeroOf(p));
    return () => parts.map((p) => p());
  }
  if (t === 'number') return () => 0;
  if (t === 'boolean') return () => false;
  if (t === 'string') return () => '';
  if (t === 'number[]') return () => [0, 0, 0];
  return () => undefined;
};

/**
 * Answers that differ from a zero, each for a reason a sweep would otherwise trip over.
 *
 * The two `Has*Loaded` waits poll until true, so a `false` would hold `onCameraApp`'s answer
 * for the whole load timeout and read as "never answers" — a harness artefact, not a finding.
 * `GetGameTimer` follows the faked clock so those deadlines still mean something.
 */
const ANSWERS: Record<string, (...args: unknown[]) => unknown> = {
  PlayerPedId: () => 1,
  GetGameTimer: () => Date.now(),
  DoesAnimDictExist: () => true,
  HasAnimDictLoaded: () => true,
  IsModelValid: () => true,
  HasModelLoaded: () => true,
  GetActiveScreenResolution: () => [1920, 1080]
};

/**
 * Not recorded as a sink. `SendNuiMessage` answers the page that sent the payload, which can
 * already see whatever it sent; the rest are how the harness captures registrations.
 */
const NOT_SINKS = new Set(['SendNuiMessage', 'RegisterNuiCallbackType']);

const DECLARATIONS = join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@citizenfx',
  'client',
  'natives_universal.d.ts'
);

for (const match of readFileSync(DECLARATIONS, 'utf8').matchAll(
  /^declare function (\w+)\(.*\): ([^;]+);$/gm
)) {
  const [, name, returns] = match as unknown as [string, string, string];
  nativeNames.push(name);
  // `server/__tests__/setup.ts` already answers a few (`GetConvar`, `RegisterCommand`); its
  // answers are the ones every other suite relies on, so they stay.
  if (g[name] !== undefined) continue;
  const answer = ANSWERS[name] ?? zeroOf(returns);
  g[name] = (...args: unknown[]) => {
    if (!NOT_SINKS.has(name)) record({ kind: 'native', sink: name, args });
    return answer(...args);
  };
}

g.RegisterNuiCallbackType = (name: unknown) => {
  registeredNuiTypes.push(String(name));
};
g.SendNuiMessage = () => true;
g.on = (event: string, handler: NuiHandler) => {
  if (!event.startsWith('__cfx_nui:')) return;
  const name = event.slice('__cfx_nui:'.length);
  nuiHandlers.set(name, [...(nuiHandlers.get(name) ?? []), handler]);
};
// Server-emitted events are trusted as far as the server is, so the hostile sweep never sends
// one; they are kept so `focusRelease.test.ts` can drive the open paths a push takes.
g.onNet = (event: string, handler: (...args: unknown[]) => unknown) => {
  netHandlers.set(event, [...(netHandlers.get(event) ?? []), handler]);
};
// `server/__tests__/setup.ts` answers this with a no-op, so the native loop above left it alone.
g.RegisterCommand = (name: unknown, handler: (...args: unknown[]) => unknown) => {
  commands.set(String(name), handler);
};
g.emitNet = (...args: unknown[]) => record({ kind: 'server', sink: 'emitNet', args });
g.TriggerServerEvent = (...args: unknown[]) => record({ kind: 'server', sink: 'emitNet', args });
// Captured and never run: a per-frame loop has nothing to do with a NUI payload.
g.setTick = () => 0;
g.clearTick = () => undefined;

/**
 * Another resource's exports: callable (`exports('Name', fn)` registers one of ours), and
 * indexable to any resource and any method, each recorded. A callback argument is called
 * once, so an export that answers through one (`screencapture`) does not hold its caller.
 */
const resourceExports = (resource: string): unknown =>
  new Proxy(
    {},
    {
      get: (_target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => {
          record({ kind: 'export', sink: `exports.${resource}.${method}`, args });
          for (const arg of args) if (typeof arg === 'function') arg();
          return undefined;
        };
      }
    }
  );
g.exports = new Proxy(() => undefined, {
  get: (_target, resource) =>
    typeof resource === 'string' && resource !== 'then' ? resourceExports(resource) : undefined
});

/** The marker every hostile value carries, so a sink can be searched for it. */
export const MARK = '__mica466';
/** A string this long is past anything a phone field holds. */
export const OVERSIZE = 65_536;
/** A number no handler produces on its own. */
export const MARK_NUMBER = 466.0466;

/** What one hostile case produced. */
export interface Outcome {
  /** Every argument list `cb` was called with. */
  answers: unknown[][];
  /** A synchronous throw or a rejected promise: either way FiveM leaves the page waiting. */
  threw: unknown;
  sinks: SinkCall[];
  /** Properties that appeared on a built-in prototype during the case. */
  polluted: string[];
}

const PROTOTYPES: [string, object][] = [
  ['Object.prototype', Object.prototype],
  ['Array.prototype', Array.prototype],
  ['Function.prototype', Function.prototype]
];

/**
 * Send one payload to one handler and wait for it to settle.
 *
 * Fake timers advance past `ServiceProxy`'s fifteen-second timeout, so a request that went to
 * the server is answered by it, the same as a server that never replied — what is asserted is
 * that the page is answered at all, exactly once, not what with.
 */
export const invoke = async (handler: NuiHandler, payload: unknown): Promise<Outcome> => {
  const answers: unknown[][] = [];
  const before = PROTOTYPES.map(([, proto]) => new Set(Object.getOwnPropertyNames(proto)));
  const sinks: SinkCall[] = [];
  let threw: unknown = undefined;
  recording = sinks;
  try {
    const result = handler(payload, (...reply: unknown[]) => answers.push(reply));
    if (result instanceof Promise) {
      result.then(undefined, (error: unknown) => {
        threw = error ?? new Error('rejected with nothing');
      });
    }
  } catch (error) {
    threw = error ?? new Error('threw nothing');
  }
  await vi.advanceTimersByTimeAsync(15_001);
  recording = null;

  const polluted: string[] = [];
  PROTOTYPES.forEach(([label, proto], i) => {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (before[i]?.has(key)) continue;
      polluted.push(`${label}.${key}`);
      delete (proto as Record<string, unknown>)[key];
    }
  });
  return { answers, threw, sinks, polluted };
};

/** Every key a handler reads off its payload, found by handing it a recording proxy. */
export const keysRead = async (handler: NuiHandler, base: Record<string, unknown>) => {
  const read = new Set<string>();
  const probe = new Proxy(
    { ...base },
    {
      get: (target, key, receiver) => {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key, receiver);
      }
    }
  );
  await invoke(handler, probe);
  // Asked of any value by the runtime rather than by the handler's own logic.
  for (const key of ['then', 'toJSON', 'constructor', '__proto__']) read.delete(key);
  return [...read].sort();
};

/** A JSON type, which is all a NUI payload can carry. */
export type JsonType = 'object' | 'array' | 'number' | 'string';

/** Where a hostile field's value landed in a sink, and as what. */
export interface Landing {
  position: string;
  type: JsonType;
}

/** An event name as a report shows it: in full when it is a name, cut when a payload filled it. */
const shown = (event: unknown): string => {
  const name = String(event);
  return name.length > 80 ? `${name.slice(0, 80)}... (${name.length} characters)` : name;
};

const positionOf = (call: SinkCall, index: number): string =>
  call.kind === 'server'
    ? `${call.sink}(${shown(call.args[0])}) arg ${index}`
    : `${call.sink} arg ${index}`;

/**
 * Where a marked value reached a sink. A string carrying the mark, the marked number, an
 * array whose first element is the marked string, or an object with a key carrying the mark.
 */
export const landings = (calls: readonly SinkCall[]): Landing[] => {
  const found: Landing[] = [];
  const walk = (value: unknown, where: string, seen: Set<unknown>): void => {
    if (typeof value === 'string') {
      if (value.includes(MARK)) found.push({ position: where, type: 'string' });
      return;
    }
    if (value === MARK_NUMBER) {
      found.push({ position: where, type: 'number' });
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (typeof value[0] === 'string' && value[0].includes(MARK)) {
        found.push({ position: where, type: 'array' });
        return;
      }
      value.forEach((item, i) => walk(item, `${where}[${i}]`, seen));
      return;
    }
    const keys = Object.keys(value);
    if (keys.some((k) => k.includes(MARK))) {
      found.push({ position: where, type: 'object' });
      return;
    }
    for (const key of keys) walk((value as Record<string, unknown>)[key], `${where}.${key}`, seen);
  };
  for (const call of calls) {
    call.args.forEach((arg, i) => walk(arg, positionOf(call, i), new Set()));
  }
  return found;
};

/** Own keys a JSON payload can carry that no phone field is named. */
const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * What is wrong with what one sink received, if anything.
 *
 * Anywhere in any argument: an own `__proto__`/`constructor`/`prototype` key, a key carrying
 * the mark (an undeclared key, or the wrong-type object), a string of `OVERSIZE` or longer,
 * or a number that is not finite. A native additionally takes only a finite number, a
 * boolean or a string at each argument — never `undefined`, `null`, an object or an array.
 */
export const sinkProblems = (call: SinkCall): string[] => {
  const problems: string[] = [];
  const walk = (value: unknown, where: string, seen: Set<unknown>): void => {
    if (typeof value === 'string') {
      if (value.length >= OVERSIZE) problems.push(`${where} is a ${value.length}-character string`);
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) problems.push(`${where} is ${value}`);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      // Reported once, at the key: what hangs under a hostile key is the same finding again.
      if (HOSTILE_KEYS.has(key) || key.includes(MARK)) {
        problems.push(`${where} carries key '${key}'`);
        continue;
      }
      walk((value as Record<string, unknown>)[key], `${where}.${key}`, seen);
    }
  };
  // Every marker starts `__`, which no event segment may, so a marker in an event name means a
  // payload value chose where a request went.
  const event = call.args[0];
  if (call.kind === 'server' && typeof event === 'string' && event.includes(MARK)) {
    problems.push(`a payload value is in the event name '${shown(event)}'`);
  }
  call.args.forEach((arg, i) => {
    const where = positionOf(call, i);
    if (call.kind === 'native') {
      // A non-finite number is the walk's to report, once.
      const ok = typeof arg === 'boolean' || typeof arg === 'string' || typeof arg === 'number';
      if (!ok) {
        const type = arg === null ? 'null' : Array.isArray(arg) ? 'array' : typeof arg;
        problems.push(`${where} is ${type}, which no native takes from a payload`);
      }
    }
    walk(arg, where, new Set());
  });
  return problems;
};
