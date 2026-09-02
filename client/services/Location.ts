// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Location: the one contracted action whose relay is not a plain passthrough, plus the
// purely local waypoint action.
import { registerClientHook } from '../lib/clientHooks';

/**
 * Resolve a human-readable street name on the sender's own client — the only place it can
 * be resolved, since `GetStreetNameAtCoord`/`GetStreetNameFromHashKey` are client-only
 * natives — and attach it to the payload before the generic relay forwards it.
 *
 * Registered as `media:shareLocation`'s client hook (MICA-213). The contract marks that
 * action `clientPrepared`, so `client/services/Relay.ts` runs this before `emitNet` and
 * owns the reply subscription; this file no longer registers a NUI callback or subscribes
 * anything itself, which is how a subscription came to be forgotten once (e1edda1).
 *
 * The server never trusts this label as anything but display text, and independently
 * re-reads the sender's position itself rather than accepting coordinates from here
 * (`server/services/Media.ts`'s `shareLocation` action, `server/lib/playerCoords.ts`) —
 * this file supplies the one thing only the client can produce, nothing more.
 */
registerClientHook('media', 'shareLocation', (data) => {
  const coords = GetEntityCoords(PlayerPedId(), true);
  const [streetHash] = GetStreetNameAtCoord(coords[0], coords[1], coords[2]);
  const label = GetStreetNameFromHashKey(streetHash) || undefined;
  const sent = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { ...sent, label };
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
