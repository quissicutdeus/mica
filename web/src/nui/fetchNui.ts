import { isBrowser } from '../lib/isBrowser';
import { getTransport } from './transport';

/**
 * A failure reply from the other side of the bridge.
 *
 * The server sends `{ error }` when a handler throws and when the caller is not
 * authenticated (`server/lib/ServiceEndpoint.ts`), and the client sends it when a request goes
 * unanswered for 15 seconds (`client/lib/ServiceProxy.ts`). All three are failures wearing
 * the shape of data.
 */
const errorFrom = (reply: unknown): string | null => {
  if (!reply || typeof reply !== 'object') return null;
  const { error } = reply as { error?: unknown };
  return typeof error === 'string' && error ? error : null;
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
export async function fetchNui<T = any>(
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
      if (!options!.quiet) {
        console.warn(`fetchNui('${eventName}') failed; using the default value.`, e);
      }
      return options!.defaultValue as T;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const error = errorFrom(reply);
  if (error) {
    if (hasDefault) {
      if (!options!.quiet) {
        console.warn(`fetchNui('${eventName}') returned an error; using the default.`, error);
      }
      return options!.defaultValue as T;
    }
    throw new Error(error);
  }

  if (hasDefault) {
    if (reply === null || reply === undefined) return options!.defaultValue as T;
    // A read that asked for an array and got something else is a failure, not data.
    if (Array.isArray(options!.defaultValue) && !Array.isArray(reply)) {
      return options!.defaultValue as T;
    }
  }

  return reply ?? (options?.defaultValue as T) ?? (null as unknown as T);
}

export { isBrowser };
