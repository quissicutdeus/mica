import { ClientApp } from '../lib/ClientApp';
import { ROUTES, serverEventFor } from '@shared/routes';

/**
 * Registers every declared route.
 *
 * This is the whole relay layer. It used to be seven files of
 * `app.registerCallback(nuiAction, serverEvent)` — data written as code, and spread
 * thinly enough that a missing line looked like nothing at all.
 *
 * One `ClientApp` per app rather than per route: `ClientApp` dedupes the response-event
 * subscription internally, and several routes legitimately share one server action
 * (`deleteConversation` and `leaveConversation` both hit `conversations:delete`).
 */
const apps = new Map<string, ClientApp>();

for (const route of ROUTES) {
  let app = apps.get(route.app);
  if (!app) {
    app = new ClientApp(route.app);
    apps.set(route.app, app);
  }
  app.registerCallback(route.action, serverEventFor(route));
}
