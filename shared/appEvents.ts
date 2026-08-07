/**
 * How the server pushes an unsolicited event to one app in one player's phone.
 *
 * Everything else in the RPC surface is request/response: `ServiceEndpoint` replies on an event
 * correlated to a cbId the *client* generated, and `ServiceProxy` times out after 15 seconds.
 * Nothing pushed. So "someone replied to you", "your listing sold", "a driver accepted" had no
 * way to reach an app at all.
 *
 * And inbound messages only ever reached the NUI through a **closed table** in
 * `shell/nuiMessages.ts` — nine hardcoded routes. A new app could not join it, and an add-on
 * installed from the Store physically cannot, because apps may import nothing outside
 * `@gphone/sdk` (`sdk/boundary.test.ts`).
 */

import { parseDeepLink } from './deepLink';

/**
 * The one net event every app push travels on.
 *
 * A literal, and deliberately not built from a template. `server/__tests__/eventNames.test.ts`
 * scans for string **literals**, so `gphone:client:${app}:...` would be an *unchecked* name —
 * whereas one literal here is checked for free by every assertion in that file. `shell` is the
 * right segment because the transport belongs to the phone rather than to any app, exactly as
 * `gphone:client:shell:notify` already does; the target app rides in the envelope.
 */
export const APP_EVENT_NET_EVENT = 'gphone:client:shell:appEvent';

/** The NUI action it becomes. A separate namespace, so no `gphone:` prefix (§8). */
export const APP_EVENT_NUI_ACTION = 'appEvent';

/** App-defined event names. `*` is reserved for the wildcard subscription. */
export const APP_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** What the shell should raise a toast about, if the app declared `notifications`. */
export interface AppEventNotification {
  type?: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  message: string;
  avatar?: string;
}

export interface AppEventEnvelope {
  /** Registry id of the app this is for. */
  app: string;
  /** App-defined event name — `mention`, `dm`, `sold`. */
  event: string;
  payload: Record<string, unknown>;
  /** Server clock, ms. Ordering, and ageing the replay buffer. */
  at: number;
  notify?: AppEventNotification;
  /**
   * Where tapping this should land, as a `shared/deepLink.ts` string.
   *
   * On the envelope rather than only on the stored row, so the **toast** and the
   * notification in the shade navigate through one contract. They did not: a toast opened
   * the app with the raw push payload (`{ blab_id, handle }`) while the shade followed
   * `deep_link` (`blab/99`) — two shapes for one destination, and Blabber read neither.
   */
  deepLink?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const name = (raw: unknown): string | null =>
  typeof raw === 'string' && APP_EVENT_NAME_PATTERN.test(raw) ? raw : null;

/**
 * Narrow an envelope off the wire, or return null.
 *
 * Run on the client hop **and** again in the NUI, because the dev harness posts straight into
 * the NUI and never crosses `client/`. Validates the envelope only — the payload is the app's
 * to check, since nothing here can tell a Blab from a taxi fare.
 *
 * Rejecting `*` as a pushed event name matters: otherwise a server push lands in the wildcard
 * bucket and every `onAny` subscriber receives something no `on('name')` ever will.
 */
export function parseAppEventEnvelope(raw: unknown): AppEventEnvelope | null {
  if (!isPlainObject(raw)) return null;

  const app = name(typeof raw.app === 'string' ? raw.app.toLowerCase() : raw.app);
  const event = name(raw.event);
  if (!app || !event) return null;
  if (!isPlainObject(raw.payload) && raw.payload !== undefined) return null;

  return {
    app,
    event,
    payload: isPlainObject(raw.payload) ? raw.payload : {},
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    notify:
      isPlainObject(raw.notify) && typeof raw.notify.message === 'string'
        ? {
            type: raw.notify.type as AppEventNotification['type'],
            title: typeof raw.notify.title === 'string' ? raw.notify.title : undefined,
            message: raw.notify.message,
            avatar: typeof raw.notify.avatar === 'string' ? raw.notify.avatar : undefined
          }
        : undefined,
    // Validated here rather than at the tap, so an unparseable link is dropped once at the
    // boundary instead of every consumer re-checking it. A field simply omitted from this
    // object is not a small mistake: `deepLink` was, and the toast fell back to the payload
    // every single time — which looks correct for a push whose payload happens to name the
    // same app, and silently goes nowhere for one that does not.
    deepLink:
      typeof raw.deepLink === 'string' && parseDeepLink(raw.deepLink) ? raw.deepLink : undefined
  };
}
