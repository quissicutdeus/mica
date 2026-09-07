// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * micaOS's public surface for other resources.
 *
 * One declaration site, for the same reason `shared/routes.ts` is one table: a surface
 * spread across the files that happen to implement it is one nobody can read, and one a
 * test cannot check. Before this, the entire public API was a single
 * `exports('SendSystemEmail', …)` sitting at the bottom of `services/Mail.ts` — everything
 * else in the tree named `exports` is micaOS *consuming* somebody else.
 *
 * The functions themselves stay in the service that owns them. Only the registration
 * lives here.
 *
 * ## Five rules, each earned by something already in the tree
 *
 * **Discriminated outcomes, never a bare boolean.** A `false` that cannot distinguish
 * "player is offline" from "micaOS has not finished starting" is unusable from the calling
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
 * another server resource can already fire `mica:server:battery:save` with
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
export const MICA_API_VERSION = 1;

/** Why an export could not do what was asked. */
/**
 * The outcome shape is shared with the client's export surface (MICA-224): one contract,
 * read once by a script that calls both sides. Re-exported here so every existing import of
 * `ok`, `fail` and the types keeps working unchanged.
 */
export { ok, fail } from '@mica/shared/exports';
export type { ExportOutcome } from '@mica/shared/exports';
import { fail, type ExportOutcome } from '@mica/shared/exports';

const guarded =
  <A extends unknown[], T>(name: string, handler: (...args: A) => ExportOutcome<T>) =>
  (...args: A): ExportOutcome<T> => {
    try {
      return handler(...args);
    } catch (error) {
      console.error(`[mica] export '${name}' threw:`, error);
      return fail<T>('internal_error', 'micaOS failed to handle that request.');
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
      console.error(`[mica] export '${name}' threw:`, error);
      return fail<T>('internal_error', 'micaOS failed to handle that request.');
    }
  };

/** Registered names, so the contract test can read the surface without a FiveM runtime. */
/**
 * Per calling resource, per export, per minute (MICA-223).
 *
 * The rate limiter in `rateLimit.ts` is keyed on a player's source, because what it guards
 * is a modified client hammering a net event. An export has no source: the caller is another
 * resource, and the one that misbehaves is not hostile but looping -- a dispatch script
 * texting every officer on every tick of a stuck timer. Keyed on `GetInvokingResource()`, so
 * one resource's loop starves nobody else's calls, and a fixed window rather than a token
 * bucket so the answer a caller reads is simple: this many per minute, and then `rate_limited`
 * until the minute turns.
 *
 * Counted before the handler runs, invalid calls included -- a loop that is also wrong is
 * still a loop.
 */
const EXPORT_WINDOW_MS = 60_000;

const exportWindows = new Map<string, { count: number; startedAt: number }>();

/** Test seam, like `rateLimit.ts`'s `__resetRateLimits`. */
export const __resetExportRateLimits = (): void => {
  exportWindows.clear();
};

const invokingResource = (): string => {
  const name = typeof GetInvokingResource === 'function' ? GetInvokingResource() : null;
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
};

const rateLimited =
  <A extends unknown[], T>(
    name: string,
    perMinute: number,
    handler: (...args: A) => Promise<ExportOutcome<T>>
  ) =>
  async (...args: A): Promise<ExportOutcome<T>> => {
    const caller = invokingResource();
    const key = `${caller}:${name}`;
    const at = Date.now();
    const current = exportWindows.get(key);
    if (!current || at - current.startedAt >= EXPORT_WINDOW_MS) {
      exportWindows.set(key, { count: 1, startedAt: at });
    } else if (++current.count > perMinute) {
      return fail<T>(
        'rate_limited',
        `'${caller}' has called ${name} more than ${perMinute} times this minute; this call was dropped.`
      );
    }
    return handler(...args);
  };

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

export { guarded, guardedAsync, rateLimited };
