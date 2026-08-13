import { ServiceProxy } from '../lib/ServiceProxy';
import { ROUTES, serverEventFor } from '@shared/routes';
import { GENERIC_SERVICE_ACTION, parseGenericRequest, requestEventFor } from '@shared/rpc';

/**
 * Registers every declared route.
 *
 * This is the whole relay layer. It used to be seven files of
 * `proxy.registerCallback(nuiAction, serverEvent)` — data written as code, and spread
 * thinly enough that a missing line looked like nothing at all.
 *
 * One `ServiceProxy` per service rather than per route: the proxy dedupes the
 * response-event subscription internally, and several routes legitimately share one
 * server action (`deleteConversation` and `leaveConversation` both hit
 * `conversations:delete`).
 */
const proxies = new Map<string, ServiceProxy>();

/**
 * Routes whose client relay is not a dumb passthrough of whatever `web/` sent — client-side
 * logic has to run *between* the NUI call and the server relay. `shareLocation` needs a
 * street name, and that can only be resolved by a client-only native
 * (`GetStreetNameAtCoord`/`GetStreetNameFromHashKey` do not exist server-side), so it
 * cannot be resolved in `web/` and handed down. Still declared in `ROUTES` for
 * completeness/mock checking; only the automatic `registerCallback` below is skipped. The
 * dedicated handler lives in `client/services/Location.ts`. Add here — and nowhere else —
 * the next time a route needs client-side work before it reaches the server.
 */
const CUSTOM_CLIENT_RELAY = new Set(['shareLocation']);

for (const route of ROUTES) {
  if (CUSTOM_CLIENT_RELAY.has(route.action)) continue;

  let proxy = proxies.get(route.service);
  if (!proxy) {
    proxy = new ServiceProxy(route.service);
    proxies.set(route.service, proxy);
  }
  proxy.registerCallback(route.action, serverEventFor(route));
}

/**
 * One callback for every service, so an app can reach its own without a route entry.
 *
 * The table above is core code enumerating every action of every app, which is why an
 * add-on installed from the Store cannot have a server half: it cannot add a row to a
 * file that ships inside gPhone. This is the door that does not require one.
 *
 * The proxy is shared with the named routes deliberately — same map, so a service reached
 * both ways has one response subscription and one pending-callback table rather than two
 * that could disagree about a cbId.
 *
 * A request naming a service the server does not have simply never gets a reply, and the
 * existing 15-second timeout answers it with an error. That is the same outcome a missing
 * route already produces, and it needs no allowlist here to arrange: the server listens
 * only on events `registerEvent` created.
 */
RegisterNuiCallbackType(GENERIC_SERVICE_ACTION);
on(`__cfx_nui:${GENERIC_SERVICE_ACTION}`, (payload: unknown, cb: Function) => {
  const request = parseGenericRequest(payload);
  if (!request) {
    // Refused rather than relayed: both segments are interpolated into an event name, so
    // an unchecked one could address anything on the bus instead of a gphone service.
    cb({ error: 'Malformed service request' });
    return;
  }

  let proxy = proxies.get(request.service);
  if (!proxy) {
    proxy = new ServiceProxy(request.service);
    proxies.set(request.service, proxy);
  }

  // Per request rather than at startup, because which replies this will need is not
  // knowable until one arrives. Deduped inside the proxy, so it is free after the first.
  proxy.ensureSubscribed(request.action);
  proxy.relay(request.action, requestEventFor(request.service, request.action), request.data, cb);
});
