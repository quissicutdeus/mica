/**
 * How gPhone builds its net event names — one definition, used by both sides.
 *
 * A NUI round trip needs three strings to agree: the action the UI calls, the server
 * event the client relays to, and the event the server replies on. When the client and
 * the server each derived that last name independently, they disagreed for every custom
 * action on the mail app, and every mail request timed out after 15 seconds with no
 * error anywhere — `fetchNui` swallows the failure and returns its `defaultValue`.
 *
 * Both `server/lib/ServerApp.ts` and `client/lib/ClientApp.ts` import from here, so the
 * two cannot drift apart again.
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

/** `gphone:server:<app>:<action>` — what the client emits to reach the server. */
export function requestEventFor(app: string, action: string): string {
  return `gphone:server:${app}:${action}`;
}

/**
 * `gphone:client:<app>:<response>` — what the server replies on, and therefore what the
 * client must subscribe to. Derived from the action, never written by hand.
 */
export function responseEventFor(app: string, action: string): string {
  return `gphone:client:${app}:${CRUD_RESPONSE_NAMES[action] ?? action}`;
}

/**
 * Recover `{ app, action }` from a request event name, so a caller holding only the
 * server event can still derive the matching response event.
 */
export function parseRequestEvent(event: string): { app: string; action: string } | null {
  const parts = event.split(':');
  if (parts.length !== 4 || parts[0] !== 'gphone' || parts[1] !== 'server') return null;
  return { app: parts[2], action: parts[3] };
}
