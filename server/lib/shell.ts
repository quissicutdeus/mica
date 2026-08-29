import { guardNetEvent } from './netGuard';
import { registerService } from './services';

/**
 * The shell service — the phone itself, rather than any app on it.
 *
 * It has no endpoint because nothing calls into it: the traffic goes one way, from the
 * server out to a player's UI. It is still a service, and declaring it here is what lets
 * `eventNames.test.ts` check the `<service>` segment against a registry instead of a
 * hard-coded list of names that were "not apps".
 */
const SHELL_SERVICE = registerService('shell');

export interface ShellNotification {
  type?: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  message: string;
}

/**
 * Raise a toast on a player's phone.
 *
 * Replaces the same `emitNet('gphone:client:shell:notify', ...)` written out at five call
 * sites across four files. The event name is derived from the service id in exactly one
 * place, so it cannot drift from what the client listens for.
 */
export const notifyPlayer = (source: number, notification: ShellNotification): void => {
  if (!notification?.message) return;
  emitNet(`gphone:client:${SHELL_SERVICE}:notify`, source, notification);
};

/**
 * Tell a freshly loaded character's phone to re-read everything the shell bootstraps.
 *
 * The CEF page loads at resource start and never unloads (AGENTS.md §8), so a player who
 * switches character without a resource restart keeps the previous character's citizenid,
 * balance, admin flag, unread counts and every app's `preload()`-populated store on screen.
 * `server/services/Settings.ts` solved this for settings alone; this is the same push at
 * the shell level, for the bootstrap state nothing else re-reads on its own.
 */
export const pushRehydrate = (source: number): void => {
  emitNet(`gphone:client:${SHELL_SERVICE}:rehydrate`, source);
};

const sourceOf = (player: unknown): number | undefined =>
  typeof player === 'number'
    ? player
    : (player as { PlayerData?: { source?: number } })?.PlayerData?.source;

/**
 * Who a network `QBCore:Server:OnPlayerLoaded` may be acted on for, or `undefined`.
 *
 * `onNet` means *any* connected client can emit this name themselves, and until MICA-136
 * all three listeners for it — here, `services/Settings.ts` and `services/Battery.ts` —
 * took the target straight out of the payload. `{ PlayerData: { source: <victim> } }` from
 * a modified client therefore rehydrated, re-read and overwrote a third party's state: the
 * only place in the resource where a payload named somebody else and was believed. Every
 * other handler derives identity from the connection, and now so does this one.
 *
 * Three checks, and none of them costs the legitimate path anything:
 *
 * - **The connection is the authority.** `source` is set by the runtime and cannot be
 *   forged. qbx_core's compat shim sends no payload at all, so there is nothing to read
 *   from it; vanilla QBCore's local Player object carries the same id the event arrived
 *   from. A payload that agrees is redundant, a payload that disagrees is a forgery, and
 *   both resolve to `source`.
 * - **`guardNetEvent`**, the preamble the other nine raw `onNet` handlers already have
 *   (`lib/netGuard.ts`). Without it the rate limiter was never consulted on this path, so
 *   one client could loop a database read per packet.
 * - **A loaded character.** `guardNetEvent`'s `getPlayer` refuses a source that belongs to
 *   nobody, which is what keeps `Battery.ts`'s `charge` and `ownerOf` maps from being
 *   seeded with an id `playerDropped` will never fire for — the unbounded-map condition
 *   MICA-113/114 closed, by a route those handlers never saw.
 *
 * The local `on('QBCore:Server:PlayerLoaded')` twins are not client-emittable and keep
 * reading the payload: vanilla QBCore triggers those in-process, where there is no
 * connection to derive an identity from.
 */
export const loadedPlayerSource = (player: unknown): number | undefined => {
  const connection = source;
  if (!Number.isInteger(connection) || connection <= 0) return undefined;

  // Rate limit and authenticate before comparing, so every invocation is counted rather
  // than only the ones that turn out to be honest.
  if (!guardNetEvent(SHELL_SERVICE, 'playerLoaded')) return undefined;

  const claimed = sourceOf(player);
  if (claimed !== undefined && claimed !== connection) return undefined;

  return connection;
};

/**
 * Mirrors `Settings.ts` and `Battery.ts`, including listening for both cores' events,
 * because the shape of the player-loaded event differs between QBCore and qbx and neither
 * is safe to assume. Kept here rather than duplicated a third time, since the push itself
 * is shell-scoped rather than owned by any one app's data.
 *
 * Network, not local: qbx_core's own compat shim `RegisterNetEvent`s this exact name and
 * fires it from the client with no payload, so a plain `on()` here throws "was not safe
 * for net" the moment a qbx_core player loads — `RegisterNetEvent`'s network-safety flag is
 * per-resource, not global, so qbx_core declaring it net-safe for itself does nothing for
 * gPhone's own handler. `onNet` still receives vanilla QBCore's local, Player-object
 * `TriggerEvent` for this same name unaffected — only the network case needed guarding.
 *
 * That reachability is the point of `onNet` and is preserved unchanged. What is not
 * preserved is believing the payload — see `loadedPlayerSource`.
 */
onNet('QBCore:Server:OnPlayerLoaded', (player: unknown) => {
  const src = loadedPlayerSource(player);
  if (src) pushRehydrate(src);
});

/** The local twin. No client can emit this one, so the payload is still the identity. */
on('QBCore:Server:PlayerLoaded', (player: unknown) => {
  const src = sourceOf(player);
  if (src) pushRehydrate(src);
});
