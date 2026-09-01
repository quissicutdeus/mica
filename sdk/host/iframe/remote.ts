// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable, type Readable } from 'svelte/store';
import { clientTransport } from './transport';
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

/** A readable fed by `push`. `initial` is what subscribers see until the first push lands. */
export function remoteStore<T>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string,
  initial: T
): Readable<T> {
  return readable<T>(initial, (set) => {
    const t = clientTransport();
    const id = nextId++;
    const off = t.onPush(id, (v) => set(v as T));
    t.send({ kind: 'subscribe', id, facet, factoryArgs, member });
    return () => {
      off();
      t.send({ kind: 'unsubscribe', id });
    };
  });
}
