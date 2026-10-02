// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable, type Readable } from 'svelte/store';
import { clientTransport, type ClientTransport } from './transport';
import { isFnRef, type FnRef } from './messages';
import { AppPermissionError } from '../protocol';
import type { AppPermission } from '../../manifest';

// MICA-16 step 4: the three primitives every iframe facet is built from — remoteCall for
// one-shot requests, remoteStore for pushed state, remoteFn for callables the shell hands back.

let nextId = 1;

/** Replace function args with CallbackRefs, recursively one level into plain objects (options bags). */
export function encodeArgs(args: unknown[]): unknown[] {
  const t = clientTransport();
  const enc = (v: unknown): unknown => {
    if (typeof v === 'function')
      return { __cb: t.registerCallback(v as (...a: unknown[]) => unknown) };
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, typeof x === 'function' ? enc(x) : x])
      );
    }
    return v;
  };
  return args.map(enc);
}

/** Turn a FnRef the shell returned into a callable that `invoke`s it. */
export function remoteFn(ref: FnRef): (...args: unknown[]) => void {
  return (...args) => clientTransport().send({ kind: 'invoke', handle: ref.__fn, args });
}

/** Replace FnRefs in a reply with callables. AppPermissionError replies rethrow as AppPermissionError. */
export function decodeValue(value: unknown): unknown {
  if (isFnRef(value)) return remoteFn(value);
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isFnRef(v) ? remoteFn(v) : v])
    );
  }
  return value;
}

export function remoteCall<T = unknown>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string,
  ...args: unknown[]
): Promise<T> {
  const t = clientTransport();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    t.onReply(id, (msg) => {
      if (msg.ok) return resolve(decodeValue(msg.value) as T);
      const e = msg.error;
      if (e.name === 'AppPermissionError' && e.permission && e.hookName) {
        return reject(new AppPermissionError(facet, e.permission as AppPermission, e.hookName));
      }
      const err = new Error(e.message);
      err.name = e.name;
      reject(err);
    });
    t.send({ kind: 'call', id, facet, factoryArgs, member, args: encodeArgs(args) });
  });
}

/**
 * One open `subscribe` on the wire, shared by every local reader of the same
 * facet + factoryArgs + member. `latest` is the last value the shell pushed, so a reader
 * joining an already-open wire starts from it rather than from its own seed.
 */
interface Wire {
  readonly sinks: Set<(value: unknown) => void>;
  received: boolean;
  latest: unknown;
  /** Stop listening, forget the wire, and send the one `unsubscribe`. */
  close(): void;
}

/**
 * Open wires per transport, then per key. Keyed by the transport first so a swap
 * (`setClientTransport` — a test's fake, or `bootAddOn`) can never hand a new reader a
 * wire that lives on the old one: a different transport is simply a different map. An
 * entry exists only while it has a reader, so there is nothing stale to reset between
 * tests either; and the `WeakMap` lets a dropped transport take its map with it.
 */
const wires = new WeakMap<ClientTransport, Map<string, Wire>>();

/** Deeper than any real options bag, and the bound that turns a cyclic arg into "uncacheable". */
const MAX_KEY_DEPTH = 8;

/**
 * A faithful string for one structured-clonable value, or `undefined` when there isn't
 * one. Only what survives `postMessage` unchanged is encoded — primitives, arrays, plain
 * objects — and anything else (a function, a symbol, a `Date`, a `Map`, a class instance,
 * a sparse array, a cycle) is refused rather than approximated, because `JSON.stringify`
 * would map `[fnA]` and `[fnB]` to the same `[null]` and silently merge two subscriptions
 * the shell would have answered differently.
 */
function keyPart(v: unknown, depth: number): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      // `String` keeps NaN and ±Infinity distinct; only -0 needs saying out loud.
      return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint':
      return `${v}n`;
    case 'string':
      return JSON.stringify(v);
    case 'object':
      break;
    default:
      return undefined;
  }
  if (depth >= MAX_KEY_DEPTH) return undefined;
  const parts: string[] = [];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) return undefined;
      const p = keyPart(v[i], depth + 1);
      if (p === undefined) return undefined;
      parts.push(p);
    }
    return `[${parts.join(',')}]`;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  for (const [k, x] of Object.entries(v)) {
    const p = keyPart(x, depth + 1);
    if (p === undefined) return undefined;
    parts.push(`${JSON.stringify(k)}:${p}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The sharing key for a subscription, or `undefined` for "do not share this one".
 * `factoryArgs` are app-controlled, and a getter or a `Proxy` can throw from inside the
 * walk — so this never throws: anything it cannot encode just gets a wire of its own,
 * exactly what every subscription had before sharing existed.
 */
function wireKey(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string
): string | undefined {
  try {
    const args = keyPart(factoryArgs, 0);
    return args === undefined
      ? undefined
      : `${JSON.stringify(facet)}|${JSON.stringify(member)}|${args}`;
  } catch {
    return undefined;
  }
}

/**
 * A readable fed by `push`. `initial` is what a reader sees until the first push lands.
 *
 * **One wire subscription per distinct facet + factoryArgs + member, not per call.** Every
 * iframe facet twin calls this once per hook invocation, so without sharing a feed of N
 * `MediaThumb`s held N `useStreamerMode()` subscriptions, each a listener in the shell, a
 * structured clone per change, and a slot against the frame's subscription cap — past
 * which the shell refuses the next one and, say, streamer-mode blur silently stops. Now
 * the first reader of a key sends the `subscribe`, later readers join it, and the
 * `unsubscribe` goes out only when the last reader leaves; the next reader after that
 * opens a fresh wire under a new id.
 *
 * Each call still returns its own `readable`, and sharing happens at subscribe time against
 * whichever transport is current then — so a module-scope store (`shims/time.ts`) built
 * before `bootAddOn` still lands on the right transport.
 *
 * **`initial` is per caller, not first-wins.** Two callers may seed the same key
 * differently; each reader sees its own `initial` until the shell has pushed once on the
 * shared wire, and from then on the shared value — a reader joining after that first push
 * starts from the latest pushed value, never from its seed. So a seed only ever covers the
 * gap before real data, which is all it did before.
 */
export function remoteStore<T>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string,
  initial: T
): Readable<T> {
  return readable<T>(initial, (set) => {
    const t = clientTransport();
    const sink = (v: unknown) => set(v as T);
    const key = wireKey(facet, factoryArgs, member);
    const wire =
      (key === undefined ? undefined : wires.get(t)?.get(key)) ??
      openWire(t, key, facet, factoryArgs, member);
    wire.sinks.add(sink);
    if (wire.received) set(wire.latest as T);
    return () => {
      wire.sinks.delete(sink);
      if (wire.sinks.size === 0) wire.close();
    };
  });
}

/** Send the `subscribe` for a new wire, and file it under `key` unless it is unshareable. */
function openWire(
  t: ClientTransport,
  key: string | undefined,
  facet: string,
  factoryArgs: readonly unknown[],
  member: string
): Wire {
  const id = nextId++;
  let byKey: Map<string, Wire> | undefined;
  if (key !== undefined) {
    byKey = wires.get(t);
    if (!byKey) {
      byKey = new Map<string, Wire>();
      wires.set(t, byKey);
    }
  }
  const wire: Wire = {
    sinks: new Set(),
    received: false,
    latest: undefined,
    close: () => {
      off();
      if (key !== undefined && byKey?.get(key) === wire) byKey.delete(key);
      t.send({ kind: 'unsubscribe', id });
    }
  };
  const off = t.onPush(id, (v) => {
    wire.received = true;
    wire.latest = v;
    for (const s of wire.sinks) s(v);
  });
  if (key !== undefined) byKey?.set(key, wire);
  t.send({ kind: 'subscribe', id, facet, factoryArgs, member });
  return wire;
}
