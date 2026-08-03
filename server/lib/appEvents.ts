import { FrameworkBridge } from './FrameworkBridge';
import {
  APP_EVENT_NET_EVENT,
  APP_EVENT_NAME_PATTERN,
  type AppEventEnvelope,
  type AppEventNotification
} from '@shared/appEvents';

/**
 * Pushing an event to one app in one player's phone.
 *
 * Bound to an app rather than taking one per call, so a mistyped id is a **startup** condition
 * instead of a silent runtime miss — the same move `ServiceProxy` makes by throwing when a
 * response event cannot be derived.
 */

type PushOutcome =
  | { delivered: true; source: number }
  /**
   * A discriminated union rather than a boolean, and that is the point: a caller must not be
   * able to read "the recipient was offline" as "the recipient was told". The type enforces it
   * at every call site, which a comment above one of them does not.
   */
  | { delivered: false; reason: 'offline' | 'oversize' | 'unserializable' };

/** ~16 KB. A push is not a transport for a base64 photo. */
const MAX_PAYLOAD_BYTES = 16_384;

interface PushOptions {
  /**
   * Ask the shell to raise a toast. Honoured only if the target app declared `notifications` —
   * checked in the NUI, where the manifest lives.
   */
  notify?: AppEventNotification;
}

export interface AppEventChannel {
  readonly appId: string;
  push(
    citizenid: string,
    event: string,
    payload?: Record<string, unknown>,
    options?: PushOptions
  ): PushOutcome;
  /** One `getAllPlayers()` snapshot for the whole fan-out. */
  pushMany(
    citizenids: readonly string[],
    event: string,
    payload?: Record<string, unknown>,
    options?: PushOptions
  ): { delivered: string[]; offline: string[] };
}

const envelopeFor = (
  app: string,
  event: string,
  payload: Record<string, unknown>,
  options?: PushOptions
): AppEventEnvelope => ({
  app,
  event,
  payload,
  at: Date.now(),
  notify: options?.notify
});

/**
 * Serialise once, and refuse rather than hitch.
 *
 * The payload crosses msgpack on `emitNet` and then JSON in `sendNuiMessage`, so `Date`, `Map`
 * and `undefined` do not survive intact — the type says JSON-shaped values for that reason.
 * Finding out that a 4 MB payload does not fit as a server stall is much worse than finding out
 * as a refusal.
 */
const measure = (payload: Record<string, unknown>): 'ok' | 'oversize' | 'unserializable' => {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return 'unserializable';
  }
  return json.length > MAX_PAYLOAD_BYTES ? 'oversize' : 'ok';
};

export function appEventChannel(appId: string): AppEventChannel {
  const app = appId.toLowerCase();
  if (!APP_EVENT_NAME_PATTERN.test(app)) {
    throw new Error(
      `appEventChannel('${appId}'): an app id must be lower_snake_case — it is the same key the ` +
        'registry, the storage namespace and every event segment use.'
    );
  }

  const send = (
    citizenid: string,
    source: number,
    event: string,
    payload: Record<string, unknown>,
    options?: PushOptions
  ): PushOutcome => {
    const size = measure(payload);
    if (size !== 'ok') {
      console.error(
        `[appEvents] Refused '${app}:${event}' to ${citizenid}: payload is ${size}. ` +
          'A push carries a reference, not a document.'
      );
      return { delivered: false, reason: size };
    }
    emitNet(APP_EVENT_NET_EVENT, source, envelopeFor(app, event, payload, options));
    return { delivered: true, source };
  };

  return {
    appId: app,

    push: (citizenid, event, payload = {}, options) => {
      if (!APP_EVENT_NAME_PATTERN.test(event)) {
        throw new Error(`appEventChannel('${app}'): event '${event}' must be lower_snake_case.`);
      }
      const source = FrameworkBridge.getSourceByCitizenId(citizenid);
      /**
       * Offline is a named outcome, not a throw and not a silent drop.
       *
       * Nothing is queued: the row that occasioned this push is already written, so the player
       * gets it from the ordinary fetch when they next open the app. `AGENTS.md` §11.6 says as
       * much — "a push channel does not exempt one, because a push only covers what arrives
       * while you are looking" — and `deliverToParticipants` already works this way.
       */
      if (source === null) return { delivered: false, reason: 'offline' };
      return send(citizenid, source, event, payload, options);
    },

    pushMany: (citizenids, event, payload = {}, options) => {
      if (!APP_EVENT_NAME_PATTERN.test(event)) {
        throw new Error(`appEventChannel('${app}'): event '${event}' must be lower_snake_case.`);
      }
      const sources = FrameworkBridge.getSourcesByCitizenId(citizenids);
      const delivered: string[] = [];
      const offline: string[] = [];

      for (const citizenid of new Set(citizenids)) {
        const source = sources.get(citizenid);
        if (source === undefined) {
          offline.push(citizenid);
          continue;
        }
        // No per-recipient log line: a forty-follower fan-out with thirty-five offline must not
        // print thirty-five warnings.
        if (send(citizenid, source, event, payload, options).delivered) delivered.push(citizenid);
      }
      return { delivered, offline };
    }
  };
}
