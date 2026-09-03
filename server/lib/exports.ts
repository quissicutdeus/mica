// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * gOS's public surface for other resources.
 *
 * One declaration site, for the same reason `shared/routes.ts` is one table: a surface
 * spread across the files that happen to implement it is one nobody can read, and one a
 * test cannot check. Before this, the entire public API was a single
 * `exports('SendSystemEmail', …)` sitting at the bottom of `services/Mail.ts` — everything
 * else in the tree named `exports` is gOS *consuming* somebody else.
 *
 * The functions themselves stay in the service that owns them. Only the registration
 * lives here.
 *
 * ## Five rules, each earned by something already in the tree
 *
 * **Discriminated outcomes, never a bare boolean.** A `false` that cannot distinguish
 * "player is offline" from "gOS has not finished starting" is unusable from the calling
 * script — the author's only move is to guess. `appEvents.ts` already learned this and
 * returns a `PushOutcome`; this mirrors its shape.
 *
 * **Never throw across the boundary.** An exception propagates into the *caller's*
 * resource and takes down a script that did nothing wrong. `SendSystemEmail` already
 * caught and returned null; this makes that uniform rather than incidental.
 *
 * **Explicit identity, and which kind is documented per export.** `citizenid` for anything
 * that must work while the player is offline (mail, notifications); `source` for anything
 * inherently live (battery, which the client half owns).
 *
 * **Never an implicit `source`.** `onNet` in CitizenFX also registers a local handler, so
 * another server resource can already fire `gos:server:battery:save` with
 * `TriggerEvent` — and for a local trigger the `source` global is not the player it meant.
 * Every export takes the player explicitly.
 *
 * **`GetApiVersion` plus a contract test.** `server/__tests__/exports.test.ts` pins every
 * exported name and arity, so a rename has to be deliberate rather than discovered by a
 * server owner. That is `routes.test.ts`'s job, one layer out.
 */

/**
 * Bumped when an existing export changes shape, not when one is added.
 *
 * A caller can therefore treat this as "the meaning of what I already call", which is the
 * only question a version answers usefully. Additions are detectable by checking whether
 * the export exists.
 */
export const GOS_API_VERSION = 1;

/** Why an export could not do what was asked. */
export type ExportFailure =
  /** No player with that source, or no character loaded on it. */
  | 'unknown_player'
  /** The player is not on the server. Their data is still safe to write by citizenid. */
  | 'offline'
  /** gOS has not finished starting. Retry, or wait for `onResourceStart`. */
  | 'not_ready'
  /** The arguments do not describe anything gOS can act on. */
  | 'invalid_args'
  /** gOS raised where it should not have. Reported rather than propagated. */
  | 'internal_error';

export type ExportOutcome<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { value?: undefined } : { value: T }))
  | { ok: false; reason: ExportFailure; message: string };

export const ok = <T = undefined>(value?: T): ExportOutcome<T> =>
  ({ ok: true, value }) as ExportOutcome<T>;

export const fail = <T = undefined>(reason: ExportFailure, message: string): ExportOutcome<T> => ({
  ok: false,
  reason,
  message
});

/**
 * Wrap a handler so nothing it does can reach the caller as an exception.
 *
 * The whole point of the boundary: a bug in gOS must degrade the phone, never the
 * script that asked it a question.
 */
const guarded =
  <A extends unknown[], T>(name: string, handler: (...args: A) => ExportOutcome<T>) =>
  (...args: A): ExportOutcome<T> => {
    try {
      return handler(...args);
    } catch (error) {
      console.error(`[gos] export '${name}' threw:`, error);
      return fail<T>('internal_error', 'gOS failed to handle that request.');
    }
  };

/**
 * The async variant. A rejected promise crosses the boundary exactly as badly as a throw.
 *
 * Note for callers: an async export returns a promise, which from Lua means the value
 * arrives later. Prefer the synchronous ones where both exist.
 */
const guardedAsync =
  <A extends unknown[], T>(name: string, handler: (...args: A) => Promise<ExportOutcome<T>>) =>
  async (...args: A): Promise<ExportOutcome<T>> => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(`[gos] export '${name}' threw:`, error);
      return fail<T>('internal_error', 'gOS failed to handle that request.');
    }
  };

/** Registered names, so the contract test can read the surface without a FiveM runtime. */
const registered = new Map<string, Function>();

/**
 * Publish one export.
 *
 * `exports` is callable only under the FiveM runtime, and this module is also imported by
 * the SQL codegen and by tests — where the host supplies a non-callable `exports` binding
 * that shadows any global stub. So the call is guarded rather than throwing on import,
 * exactly as `Mail.ts` already had to do. The name is recorded either way, which is what
 * lets the contract test run at all.
 */
export function publish(name: string, fn: Function): void {
  registered.set(name, fn);
  if (typeof exports === 'function') {
    (exports as unknown as (name: string, fn: Function) => void)(name, fn);
  }
}

/** Every published export name. For the contract test. */
export const publishedExports = (): string[] => [...registered.keys()].sort();

/** One published export, for driving it in a test. */
export const publishedExport = (name: string): Function | undefined => registered.get(name);

export { guarded, guardedAsync };
