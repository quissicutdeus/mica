// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Readable } from 'svelte/store';
import { remoteCall, remoteStore } from '../remote';

// MICA-16 step 4: the two building blocks every iframe facet twin is made of.

/**
 * Maps an inProcess facet's return shape onto what an iframe twin can actually offer
 * (MICA-26). A twin never accepts writes back from the sandboxed side — `store()` below
 * only ever hands back a `Readable` — so every store member (`Writable`, a `derived`, or a
 * store augmented with its own methods, e.g. `contactsStore`'s `.add`/`.patch`) collapses to
 * a plain `Readable`. Everything else (functions, plain values) passes through unchanged,
 * which is what lets a facet file drop `as unknown as Twin` and get real structural
 * checking: a member that's missing, renamed, or the wrong shape now fails at the object
 * literal, not silently.
 */
export type AsTwin<T> = {
  [K in keyof T]: T[K] extends Readable<infer U> ? Readable<U> : T[K];
};

/**
 * A member that is a function on the twin: `(...args) => Promise<result>`.
 *
 * Generic so a call site (`fn('account', [], 'fetchBalance')`, checked against a facet's
 * `Twin` object literal) is verified against the real member type via TypeScript's
 * contextual-type inference — `F` has nothing else to infer it from, so the compiler falls
 * back to the expected type at the call site. That confines the one unavoidable cast (the
 * wire genuinely returns `unknown` until decoded) to this single helper, instead of a blank
 * `as unknown as Twin` hiding an entire object's worth of members from the checker.
 */
// A generic function-shape constraint; `unknown[]`/`Promise<unknown>` here would block inferring the real `F` at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fn = <F extends (...args: any[]) => Promise<any>>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string
): F => ((...args: unknown[]) => remoteCall(facet, factoryArgs, member, ...args)) as F;

/** A member that is a store on the twin. */
export const store = <T>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string,
  initial: T
): Readable<T> => remoteStore<T>(facet, factoryArgs, member, initial);
