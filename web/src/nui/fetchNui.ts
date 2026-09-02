// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { t, type TranslateParams } from '../../../sdk/i18n';
import { registerNuiTransport } from '../../../sdk/nui/transport';
import { getTransport } from './transport';

/**
 * A failure reply from the other side of the bridge.
 *
 * The server sends `{ error }` when a handler throws and when the caller is not
 * authenticated (`server/lib/ServiceEndpoint.ts`), and the client sends it when a request goes
 * unanswered for 15 seconds (`client/lib/ServiceProxy.ts`). All three are failures wearing
 * the shape of data.
 */
/**
 * The message an error reply carries, in the player's language where possible (MICA-216).
 *
 * The server sends `{ error, key?, params? }`: `error` is English, `key` names an entry in
 * the shell's `server` catalog. The key wins when the catalog knows it, so a refusal reads
 * in the phone's language; an unknown key — an add-on's own server half, say — falls back
 * to the English it sent, which is exactly what it showed before.
 */
const errorFrom = (reply: unknown): string | null => {
  if (!reply || typeof reply !== 'object') return null;
  const { error, key, params } = reply as { error?: unknown; key?: unknown; params?: unknown };
  if (typeof error !== 'string' || !error) return null;
  if (typeof key === 'string' && key) {
    const translated = get(t)(key, (params ?? undefined) as TranslateParams | undefined);
    if (translated !== key) return translated;
  }
  return error;
};

/**
 * Call a NUI endpoint.
 *
 * The contract is decided by `defaultValue`, and the split is deliberate:
 *
 * - **Supplied** — never throws. Returns the default on a transport failure, an error
 *   reply, or a reply of the wrong shape. For reads, where an empty list beats an
 *   exception.
 * - **Omitted** — throws on either failure. For writes, where the caller has to be able
 *   to tell that nothing happened.
 *
 * The second half is new. This used to swallow everything and return `null`, which made
 * the `try/catch` in all five stores unreachable and let an error reply through as data:
 * `contacts.add` pushed `{ error: 'Player not authenticated' }` into the contact list and
 * reported success.
 */
export async function fetchNui<T = unknown>(
  eventName: string,
  data?: unknown,
  options?: { defaultValue?: T; quiet?: boolean }
): Promise<T> {
  const hasDefault = options?.defaultValue !== undefined;

  let reply: T;
  try {
    reply = await getTransport().send<T>(eventName, data);
  } catch (e) {
    if (hasDefault) {
      if (!options.quiet) {
        console.warn(`fetchNui('${eventName}') failed; using the default value.`, e);
      }
      return options.defaultValue as T;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const error = errorFrom(reply);
  if (error) {
    if (hasDefault) {
      if (!options.quiet) {
        console.warn(`fetchNui('${eventName}') returned an error; using the default.`, error);
      }
      return options.defaultValue as T;
    }
    throw new Error(error);
  }

  if (hasDefault) {
    if (reply === null || reply === undefined) return options.defaultValue as T;
    // A read that asked for an array and got something else is a failure, not data.
    if (Array.isArray(options.defaultValue) && !Array.isArray(reply)) {
      return options.defaultValue as T;
    }
  }

  return reply ?? (options?.defaultValue as T) ?? (null as unknown as T);
}

/**
 * MICA-172 removed an `export { isBrowser };` from here, and its import with it. The
 * re-export let callers of this module get the predicate without a second import, and its
 * last consumers left when `useNuiBridge` and the two store factories moved onto
 * `sdk/nui/transport`. `isBrowser` is still public — `sdk/utils.ts` exports it straight from
 * `sdk/lib/isBrowser`, which is where it lives. `pnpm deadcode` is what noticed it; no other
 * gate would have, which is the argument for it being in the set.
 */

/**
 * Install this bundle's transport (MICA-172). Importing this module is how the phone says
 * `fetchNui` means the real CEF/mock transport — see `sdk/nui/transport.ts`.
 *
 * **A wrapper, not `registerNuiTransport(fetchNui)`.** Registering the binding directly
 * captures the function as it is at import time, and a test that later does
 * `vi.spyOn(fetchNuiModule, 'fetchNui')` replaces the module's export without touching the
 * copy the seam holds — so the code under test calls the real transport while the test
 * asserts against its own stub, and the failure reads as bad fixture data rather than a
 * stale binding. That is the trap `useNuiBridge`'s own docblock describes at length, and it
 * cost this ticket 43 red tests to rediscover one file away from where it is written down.
 *
 * Spread, not a fixed three parameters: forwarding `(name, data, options)` turns a
 * two-argument call into a three-argument one with a trailing `undefined`, which changes
 * nothing at runtime and breaks every `toHaveBeenCalledWith` asserting the real call shape.
 */
registerNuiTransport((...args) => fetchNui(...args));
