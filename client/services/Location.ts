// Location: the one NUI action whose client relay is not a plain passthrough, plus the
// purely local waypoint action. `shared/routes.ts` and `client/services/Relay.ts` explain
// why `shareLocation` is not handled by the generic loop there.
import { ServiceProxy } from '../lib/ServiceProxy';
import { requestEventFor } from '@shared/rpc';

const proxy = new ServiceProxy('media');

/**
 * Resolve a human-readable street name on the sender's own client — the only place it can
 * be resolved, since `GetStreetNameAtCoord`/`GetStreetNameFromHashKey` are client-only
 * natives — then relay to the server with that label attached.
 *
 * The server never trusts this label as anything but display text, and independently
 * re-reads the sender's position itself rather than accepting coordinates from here
 * (`server/services/Media.ts`'s `shareLocation` action, `server/lib/playerCoords.ts`) —
 * this file supplies the one thing only the client can produce, nothing more.
 */
RegisterNuiCallbackType('shareLocation');
on('__cfx_nui:shareLocation', (_data: unknown, cb: Function) => {
  const coords = GetEntityCoords(PlayerPedId(), true);
  const [streetHash] = GetStreetNameAtCoord(coords[0], coords[1], coords[2]);
  const label = GetStreetNameFromHashKey(streetHash) || undefined;
  proxy.relay('shareLocation', requestEventFor('media', 'shareLocation'), { label }, cb);
});

/**
 * Set a GPS waypoint from a location a message already carries. Purely local — no server
 * round trip, since the coordinates arrived with the message and the effect (a marker on
 * this player's own map) has nothing for the server to authorize.
 */
RegisterNuiCallbackType('setWaypoint');
on('__cfx_nui:setWaypoint', (data: { x: number; y: number }, cb: Function) => {
  SetNewWaypoint(data.x, data.y);
  cb({ ok: true });
});
