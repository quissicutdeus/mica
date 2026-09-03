// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceProxy } from '../lib/ServiceProxy';
import { clientHookFor } from '../lib/clientHooks';
import { ROUTES, serverEventFor } from '@gos/shared/routes';
import { GENERIC_SERVICE_ACTION, parseGenericRequest, requestEventFor } from '@gos/shared/rpc';
import { contractFor, isClientPrepared } from '@gos/shared/contract';
// Evaluating the barrel is what populates `contractFor` — the same registration-by-import
// the server relies on. Without it every contract answers undefined here and no action
// would ever be seen as `clientPrepared`.
import '@gos/shared/contracts';

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

/**
 * One callback for every service, so an app can reach its own without a route entry.
 *
 * The table above is core code enumerating every action of every app, which is why an
 * add-on installed from the Store cannot have a server half: it cannot add a row to a
 * file that ships inside gOS. This is the door that does not require one.
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
on(`__cfx_nui:${GENERIC_SERVICE_ACTION}`, async (payload: unknown, cb: Function) => {
  const request = parseGenericRequest(payload);
  if (!request) {
    // Refused rather than relayed: both segments are interpolated into an event name, so
    // an unchecked one could address anything on the bus instead of a gos service.
    cb({ error: 'Malformed service request' });
    return;
  }

  /**
   * The contract's client-side step, where it declares one (MICA-213).
   *
   * `clientPrepared` on a contract action means the server expects something only this
   * client can supply — a street name, today — and `client/lib/clientHooks.ts` is where the
   * step is registered. Forwarding such an action with no hook would send a payload the
   * server refuses for a missing field, so it is refused here instead, naming the gap.
   * A contract that declares no such thing, or a service with no contract at all (an
   * add-on's), forwards exactly as before.
   */
  let data = request.data;
  const contract = contractFor(request.service);
  if (contract && isClientPrepared(contract, request.action)) {
    const hook = clientHookFor(request.service, request.action);
    if (!hook) {
      cb({ error: `No client hook registered for ${request.service}:${request.action}` });
      return;
    }
    data = await hook(data);
  }

  let proxy = proxies.get(request.service);
  if (!proxy) {
    proxy = new ServiceProxy(request.service);
    proxies.set(request.service, proxy);
  }

  // Per request rather than at startup, because which replies this will need is not
  // knowable until one arrives. Deduped inside the proxy, so it is free after the first.
  proxy.ensureSubscribed(request.action);
  proxy.relay(request.action, requestEventFor(request.service, request.action), data, cb);
});
