import { FrameworkBridge } from './FrameworkBridge';
import {
  APP_EVENT_NET_EVENT,
  APP_EVENT_NAME_PATTERN,
  type AppEventEnvelope,
  type AppEventNotification
} from '@shared/appEvents';
import { getNotificationsRepository } from '../services/Notifications';

type PushOutcome =
  | { delivered: true; source: number }
  | { delivered: false; reason: 'offline' | 'oversize' | 'unserializable' };

/** ~16 KB. A push is not a transport for a base64 photo. */
const MAX_PAYLOAD_BYTES = 16_384;

export interface PushOptions {
  /**
   * Ask the shell to raise a toast. Honoured only if the target app declared `notifications`.
   */
  notify?: AppEventNotification;
  /** Kind of notification for persistent storage. Defaults to event name. */
  kind?: string;
  /** Title for persistent storage. Defaults to notification title or app name. */
  title?: string;
  /** Deep link route for persistent storage. */
  deepLink?: string;
  /** Whether to persist the notification row. Defaults to true if notify is provided. */
  persist?: boolean;
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

const measure = (payload: Record<string, unknown>): 'ok' | 'oversize' | 'unserializable' => {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return 'unserializable';
  }
  return json.length > MAX_PAYLOAD_BYTES ? 'oversize' : 'ok';
};

function persistNotificationsAsync(
  app: string,
  event: string,
  citizenids: string[],
  payload: Record<string, unknown>,
  options?: PushOptions
) {
  if (options?.persist === false) return;
  if (!options?.notify && !options?.persist) return;

  const repo = getNotificationsRepository();
  if (!repo) return;

  const notifyObj = options.notify;
  const title = options.title ?? notifyObj?.title ?? app;
  const body =
    notifyObj?.message ?? (typeof payload.message === 'string' ? payload.message : event);
  const avatar = notifyObj?.avatar;
  const kind = options.kind ?? event;
  const deepLink = options.deepLink;

  const items = citizenids.map((citizenid) => ({
    citizenid,
    app,
    kind,
    title,
    body,
    avatar,
    deep_link: deepLink
  }));

  repo.createNotificationBatch(items).catch(() => {});
}

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

      // Persist notification asynchronously regardless of online state
      persistNotificationsAsync(app, event, [citizenid], payload, options);

      const source = FrameworkBridge.getSourceByCitizenId(citizenid);
      if (source === null) return { delivered: false, reason: 'offline' };
      return send(citizenid, source, event, payload, options);
    },

    pushMany: (citizenids, event, payload = {}, options) => {
      if (!APP_EVENT_NAME_PATTERN.test(event)) {
        throw new Error(`appEventChannel('${app}'): event '${event}' must be lower_snake_case.`);
      }

      const uniqueCitizenids = [...new Set(citizenids)];
      // Persist notification batch asynchronously regardless of online state
      persistNotificationsAsync(app, event, uniqueCitizenids, payload, options);

      const sources = FrameworkBridge.getSourcesByCitizenId(citizenids);
      const delivered: string[] = [];
      const offline: string[] = [];

      for (const citizenid of uniqueCitizenids) {
        const source = sources.get(citizenid);
        if (source === undefined) {
          offline.push(citizenid);
          continue;
        }
        if (send(citizenid, source, event, payload, options).delivered) delivered.push(citizenid);
      }
      return { delivered, offline };
    }
  };
}
