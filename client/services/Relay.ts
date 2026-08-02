import { ServiceProxy } from '../lib/ServiceProxy';
import { ROUTES, serverEventFor } from '@shared/routes';

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

for (const route of ROUTES) {
  let proxy = proxies.get(route.service);
  if (!proxy) {
    proxy = new ServiceProxy(route.service);
    proxies.set(route.service, proxy);
  }
  proxy.registerCallback(route.action, serverEventFor(route));
}
