import type { AppEventEnvelope } from '@shared/appEvents';

/**
 * The bus a pushed event lands on, and the buffer that keeps it until somebody is listening.
 *
 * **The fact this is built around:** the CEF page loads at resource start and never unloads.
 * `Shell.svelte`'s `visible` is an `{#if}`, so closing the phone destroys `PhoneFrame` and every
 * mounted app component — but `window` message listeners and every module-scope store here
 * survive untouched. `mailStore` already depends on that.
 *
 * So app residency (`MAX_RESIDENT_APPS = 5`, LRU) is **not** a delivery problem; it is a
 * subscription-lifetime problem. This lives at module scope and a component's `on(...)` is a
 * temporary window onto it. Which gives two useful lifetimes:
 *
 *   - **Module scope** — permanent, never misses. What a `badgeStore` has to be fed from.
 *   - **Component scope** — mount-scoped, and replayed on subscribe from the buffer below.
 */

export interface AppEvent<T = Record<string, unknown>> {
  app: string;
  event: string;
  payload: T;
  at: number;
  /** Arrived before this handler existed, and is being replayed. */
  replayed: boolean;
}

type Handler = (event: AppEvent) => void;

/** Per app. Enough that a player who steps away comes back to a badge, not a flood. */
const MAX_BUFFERED_PER_APP = 25;

/**
 * Nested rather than keyed on `${app}:${event}`, so no separator can be smuggled through an
 * event name into another app's bucket.
 */
const handlers = new Map<string, Map<string, Set<Handler>>>();
const buffered = new Map<string, AppEvent[]>();

/** Test seam, matching `__resetBatteryCache` and friends. */
export const __resetAppEvents = (): void => {
  handlers.clear();
  buffered.clear();
};

const listeners = (app: string, event: string): Set<Handler> | undefined =>
  handlers.get(app)?.get(event);

/**
 * Hand an envelope to whoever is listening, or hold it.
 *
 * An event is **taken** if at least one handler for `(app, event)` or `(app, '*')` ran.
 * Otherwise it is buffered, oldest dropped past the cap with a warning — a silent drop would
 * make a missing notification indistinguishable from one that never arrived.
 */
export function deliverAppEvent(envelope: AppEventEnvelope): void {
  const event: AppEvent = {
    app: envelope.app,
    event: envelope.event,
    payload: envelope.payload,
    at: envelope.at,
    replayed: false
  };

  const exact = listeners(envelope.app, envelope.event);
  const wildcard = listeners(envelope.app, '*');
  const taken = (exact?.size ?? 0) + (wildcard?.size ?? 0) > 0;

  if (taken) {
    for (const handler of [...(exact ?? []), ...(wildcard ?? [])]) {
      try {
        handler(event);
      } catch (error) {
        // One app's handler must not stop another's, and must not stop the buffer working.
        console.error(`[appEvents] Handler for '${envelope.app}:${envelope.event}' threw:`, error);
      }
    }
    return;
  }

  const queue = buffered.get(envelope.app) ?? [];
  queue.push(event);
  if (queue.length > MAX_BUFFERED_PER_APP) {
    queue.shift();
    console.warn(
      `[appEvents] '${envelope.app}' has buffered more than ${MAX_BUFFERED_PER_APP} events; ` +
        'the oldest is being dropped. Nothing is subscribed, or nothing is clearing them.'
    );
  }
  buffered.set(envelope.app, queue);
}

/**
 * Listen, and receive anything that arrived before you did.
 *
 * The replay is what makes a component-scope subscription safe: an app that was not mounted when
 * the event landed still sees it on the way in, flagged `replayed` so a caller can tell a live
 * notification from a catch-up.
 */
export function subscribeAppEvent(app: string, event: string, handler: Handler): () => void {
  const byEvent = handlers.get(app) ?? new Map<string, Set<Handler>>();
  const set = byEvent.get(event) ?? new Set<Handler>();
  set.add(handler);
  byEvent.set(event, set);
  handlers.set(app, byEvent);

  const queue = buffered.get(app);
  if (queue?.length) {
    const mine = event === '*' ? queue : queue.filter((buffer) => buffer.event === event);
    if (mine.length) {
      buffered.set(
        app,
        queue.filter((buffer) => !mine.includes(buffer))
      );
      for (const buffer of mine) handler({ ...buffer, replayed: true });
    }
  }

  return () => {
    set.delete(handler);
  };
}

/** Drop anything buffered for an app, after a fetch has made it redundant. */
export function clearAppEvents(app: string): void {
  buffered.delete(app);
}
