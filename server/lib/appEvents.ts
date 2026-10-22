// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import {
  APP_EVENT_NET_EVENT,
  APP_EVENT_NAME_PATTERN,
  type AppEventEnvelope,
  type AppEventNotification
} from '@mica/shared/appEvents';
import { getNotificationsRepository, notificationFailureReason } from '../services/Notifications';
import { who } from './who';
import { withoutOwnerKeys } from './replyShape';

type PushOutcome =
  | { delivered: true; source: number }
  | { delivered: false; reason: 'offline' | 'oversize' | 'unserializable' };

/** ~16 KB. A push is not a transport for a base64 photo. */
export const MAX_PAYLOAD_BYTES = 16_384;

export interface PushOptions {
  /**
   * Ask the shell to raise a toast. Honoured only if the target app declared `notifications`.
   */
  notify?: AppEventNotification;
  /** Kind of notification for persistent storage. Defaults to event name. */
  kind?: string;
  /** Title for persistent storage. Defaults to notification title or app name. */
  title?: string;
  /**
   * Body for persistent storage. Defaults to the notification's message, else the payload's
   * `message`, else the event name. `''` keeps the toast's text out of the stored row — for a
   * body sealed at rest elsewhere, whose plaintext copy here would undo the seal (MICA-165).
   */
  body?: string;
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
  options: PushOptions | undefined,
  persisted: boolean
): AppEventEnvelope => ({
  app,
  event,
  // No push carries a citizenid or a phone id either (MICA-433), as no reply does.
  payload: withoutOwnerKeys(payload) as Record<string, unknown>,
  at: Date.now(),
  notify: options?.notify,
  deepLink: options?.deepLink,
  persisted
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

/**
 * Start storing the notification rows for a push, and say whether it did (MICA-365).
 *
 * The answer is the envelope's `persisted`: true exactly when a write was started here —
 * `notify` or `persist` given, `persist` not `false`, and a repository to write to. `persist`
 * without `notify` is a real case (a row with no toast) and counts. The write itself is still
 * never awaited, so `true` means "a row is on its way", not "a row is committed".
 */
function persistNotificationsAsync(
  app: string,
  event: string,
  citizenids: string[],
  payload: Record<string, unknown>,
  options?: PushOptions
): boolean {
  if (options?.persist === false) return false;
  if (!options?.notify && !options?.persist) return false;

  const repo = getNotificationsRepository();
  if (!repo) return false;

  const notifyObj = options.notify;
  const title = options.title ?? notifyObj?.title ?? app;
  const body =
    options.body ??
    notifyObj?.message ??
    (typeof payload.message === 'string' ? payload.message : event);
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

  // Never awaited and never thrown: a push must not fail the write that occasioned it (§8).
  // The batch already logs a failed insert per batch; this is for anything it did not catch,
  // logged by app, event and count only, never the body (MICA-329).
  repo.createNotificationBatch(items).catch((error: unknown) => {
    console.error(
      `[appEvents] could not store '${app}:${event}' notification(s) for ` +
        `${items.length} recipient(s): ${notificationFailureReason(error)}`
    );
  });
  return true;
}

/** Where one envelope goes: `emitNet` to a real source, or the integration door's buffer. */
type Deliver = (envelope: AppEventEnvelope) => void;

/**
 * Who a push goes to: a connected player's source and `emitNet`, or — for a citizen no source
 * answers for, claimed by the integration door (MICA-397) — its synthetic source and a buffer.
 */
interface Recipient {
  source: number;
  deliver: Deliver;
}

/**
 * Installed by `lib/integrationDoor.ts` and only while `mica_integration` was `1` at start;
 * null otherwise, which is every real server. Asked only for a citizen the registry and the
 * walk both found offline, so it can never take a push meant for a connected player.
 */
let pushCapture: ((citizenid: string) => Recipient | null) | null = null;

export const setPushCapture = (capture: ((citizenid: string) => Recipient | null) | null): void => {
  pushCapture = capture;
};

/** A connected player's source, or the capture's claim on an offline citizen, or nobody. */
const recipientFor = (citizenid: string, source: number | null | undefined): Recipient | null =>
  typeof source === 'number'
    ? { source, deliver: (envelope) => emitNet(APP_EVENT_NET_EVENT, source, envelope) }
    : (pushCapture?.(citizenid) ?? null);

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
    deliver: Deliver,
    event: string,
    payload: Record<string, unknown>,
    options: PushOptions | undefined,
    persisted: boolean
  ): PushOutcome => {
    const size = measure(payload);
    if (size !== 'ok') {
      console.error(
        `[appEvents] Refused '${app}:${event}' to ${who(citizenid)}: payload is ${size}. ` +
          'A push carries a reference, not a document.'
      );
      return { delivered: false, reason: size };
    }
    deliver(envelopeFor(app, event, payload, options, persisted));
    return { delivered: true, source };
  };

  return {
    appId: app,

    push: (citizenid, event, payload = {}, options) => {
      if (!APP_EVENT_NAME_PATTERN.test(event)) {
        throw new Error(`appEventChannel('${app}'): event '${event}' must be lower_snake_case.`);
      }

      // Persist notification asynchronously regardless of online state
      const persisted = persistNotificationsAsync(app, event, [citizenid], payload, options);

      const to = recipientFor(citizenid, FrameworkBridge.getSourceByCitizenId(citizenid));
      if (!to) return { delivered: false, reason: 'offline' };
      return send(citizenid, to.source, to.deliver, event, payload, options, persisted);
    },

    pushMany: (citizenids, event, payload = {}, options) => {
      if (!APP_EVENT_NAME_PATTERN.test(event)) {
        throw new Error(`appEventChannel('${app}'): event '${event}' must be lower_snake_case.`);
      }

      const uniqueCitizenids = [...new Set(citizenids)];
      // Persist notification batch asynchronously regardless of online state
      const persisted = persistNotificationsAsync(app, event, uniqueCitizenids, payload, options);

      const sources = FrameworkBridge.getSourcesByCitizenId(citizenids);
      const delivered: string[] = [];
      const offline: string[] = [];

      for (const citizenid of uniqueCitizenids) {
        const to = recipientFor(citizenid, sources.get(citizenid));
        if (!to) {
          offline.push(citizenid);
          continue;
        }
        if (send(citizenid, to.source, to.deliver, event, payload, options, persisted).delivered) {
          delivered.push(citizenid);
        }
      }
      return { delivered, offline };
    }
  };
}
