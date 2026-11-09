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
 *
 * `label` is this file's alone. A page's own `label` is dropped whether or not the street has
 * a name, so an unnamed road never lets the page's text through in the native's place. And
 * an unnamed road sends no `label` key at all rather than `label: undefined`: the contract's
 * `s.string().optional()` admits an absent key but refuses `null`, which is what msgpack may
 * well make of `undefined` on the way (unverified in game), and that would fail every share
 * from a road with no name.
 */
registerClientHook('media', 'shareLocation', (data) => {
  const coords = GetEntityCoords(PlayerPedId(), true);
  const [streetHash] = GetStreetNameAtCoord(coords[0], coords[1], coords[2]);
  const label = GetStreetNameFromHashKey(streetHash);
  const prepared: Record<string, unknown> =
    data && typeof data === 'object' ? { ...(data as Record<string, unknown>) } : {};
  delete prepared.label;
  if (label) prepared.label = label;
  return prepared;
});

/**
 * The two map coordinates a waypoint request names, or null when it does not name two
 * (MICA-466).
 *
 * Setting a GPS waypoint from a location a message already carries is purely local — no
 * server round trip, since the coordinates arrived with the message and the effect (a marker
 * on this player's own map) has nothing for the server to authorize. Every caller in `web/` sends `{ x, y }` as numbers, each read off a stored location and
 * type-checked first. The page is reachable by any script in it (AGENTS.md §7), and a native
 * handed anything else does something unreported in game rather than failing, so only two
 * finite numbers reach `SetNewWaypoint`. A saved place whose position would not read arrives
 * as `null` for both and is refused too: there is no waypoint to set, and the page's error
 * reply is the honest answer.
 */
const waypointOf = (data: unknown): { x: number; y: number } | null => {
  const { x, y } = (data ?? {}) as { x?: unknown; y?: unknown };
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
};

RegisterNuiCallbackType('setWaypoint');
on('__cfx_nui:setWaypoint', (data: unknown, cb: Function) => {
  const point = waypointOf(data);
  if (!point) {
    cb({ ok: false, error: 'Invalid waypoint' });
    return;
  }
  SetNewWaypoint(point.x, point.y);
  cb({ ok: true });
});
