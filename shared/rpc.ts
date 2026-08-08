/**
 * How gPhone builds its net event names — one definition, used by both sides.
 *
 * A NUI round trip needs three strings to agree: the action the UI calls, the server
 * event the client relays to, and the event the server replies on. When the client and
 * the server each derived that last name independently, they disagreed for every custom
 * action on the mail app, and every mail request timed out after 15 seconds with no
 * error anywhere — `fetchNui` swallows the failure and returns its `defaultValue`.
 *
 * Both `server/lib/ServiceEndpoint.ts` and `client/lib/ServiceProxy.ts` import from here,
 * so the two cannot drift apart again.
 */

/**
 * The four generic CRUD actions reply on a differently-named event; everything else
 * replies on its own action name.
 */
const CRUD_RESPONSE_NAMES: Record<string, string> = {
  get: 'receive',
  create: 'created',
  update: 'updated',
  delete: 'deleted'
};

/** `gphone:server:<service>:<action>` — what the client emits to reach the server. */
export function requestEventFor(service: string, action: string): string {
  return `gphone:server:${service}:${action}`;
}

/**
 * `gphone:client:<service>:<response>` — what the server replies on, and therefore what
 * the client must subscribe to. Derived from the action, never written by hand.
 */
export function responseEventFor(service: string, action: string): string {
  return `gphone:client:${service}:${CRUD_RESPONSE_NAMES[action] ?? action}`;
}

/**
 * Recover `{ service, action }` from a request event name, so a caller holding only the
 * server event can still derive the matching response event.
 */
export function parseRequestEvent(event: string): { service: string; action: string } | null {
  const parts = event.split(':');
  if (parts.length !== 4 || parts[0] !== 'gphone' || parts[1] !== 'server') return null;
  return { service: parts[2], action: parts[3] };
}

/**
 * The one NUI callback every service is reachable through.
 *
 * `shared/routes.ts` names each action individually, and `client/services/Relay.ts`
 * registers a NUI callback per entry — which works, and means the table is core code that
 * has to know every action of every app. An add-on installed from the Store cannot add a
 * row to it, so it cannot have a server half at all: the Store path supports UI-only apps.
 *
 * This is the way through. One callback carrying `{ service, action, data }`, relayed to
 * the event the two segments derive, so an app reaches its own service without core
 * naming it.
 *
 * **It is not a widening of what NUI can reach.** The server only listens on events a
 * `registerEvent` created, so the reachable set is exactly the set of registered actions
 * — which is what the route table enumerates anyway. And it changes nothing about
 * authority: `ServiceEndpoint` still authenticates the caller, rate-limits per
 * `(source, service, action)`, and reduces the payload to the declared allowlist (§2.9).
 * A NUI request was never proof of intent and still is not.
 *
 * The named routes stay. They are checked by `routes.test.ts` against the `fetchNui`
 * calls, the server registrations and the browser mock, and that check is worth keeping
 * for the apps that ship in-tree — it catches the missing-layer bug that silently does
 * nothing in game.
 */
export const GENERIC_SERVICE_ACTION = 'svc';

/** What the generic callback carries. Both segments are validated before use. */
export interface GenericServiceRequest {
  service: string;
  action: string;
  data?: unknown;
}

/** The shape a service or action segment must have — the same one event names require. */
const SEGMENT = /^[a-z][a-z0-9_]*$/;

/**
 * Narrow a generic request, or return null.
 *
 * Both segments are interpolated into an event name, so an unvalidated one could name any
 * event on the bus rather than a `gphone:server:*` one. The pattern is what keeps the
 * derived name inside the namespace.
 */
export function parseGenericRequest(raw: unknown): GenericServiceRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { service, action, data } = raw as Record<string, unknown>;
  if (typeof service !== 'string' || !SEGMENT.test(service)) return null;
  if (typeof action !== 'string' || !SEGMENT.test(action)) return null;
  return { service, action, data };
}
