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
 * Sources already told about, so one client emitting this in a loop produces one line and
 * not one per packet. A log an attacker can grow without bound is its own denial of service,
 * which is why `guardNetEvent` refuses silently in the first place.
 *
 * Cleared on drop for the reason `rateLimit.forgetSource` gives: FiveM recycles server ids,
 * so a stale entry would silence a real problem for whoever is assigned this id next. That
 * also bounds the set by the number of connected players.
 */
const refusalsLogged = new Set<number>();

on('playerDropped', () => {
  refusalsLogged.delete(source);
});

/**
 * Refuse, and say so once.
 *
 * `guardNetEvent` refuses silently by design — these events carry no callback id, so there
 * is nobody waiting to be told (`lib/netGuard.ts`). That is right for a flood and wrong for
 * the ordering case: under a custom multichar, or a core that announces a character before
 * the framework has registered it, gPhone would simply never rehydrate settings and never
 * load battery, with no output anywhere and every suite still green. Silence that reads as
 * success is the thing the house rules exist to prevent, so this one refusal is audible.
 */
const refuse = (connection: number, why: string): undefined => {
  if (!refusalsLogged.has(connection)) {
    refusalsLogged.add(connection);
    console.warn(
      `[gphone] ignored QBCore:Server:OnPlayerLoaded from source ${connection}: ${why}.`
    );
  }
  return undefined;
};

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
 *   forged, and no legitimate caller of this event name supplies an identity anyway: every
 *   trigger of it on this server is a client-side `TriggerServerEvent` with no payload (see
 *   the listener below). A payload that agrees is therefore redundant, one that disagrees is
 *   a forgery, and both resolve to `source`.
 * - **`guardNetEvent`**, the preamble the other nine raw `onNet` handlers already have
 *   (`lib/netGuard.ts`). Without it the rate limiter was never consulted on this path, so
 *   one client could loop a database read per packet.
 * - **A loaded character.** `guardNetEvent`'s `getPlayer` refuses a source that belongs to
 *   nobody, which is what keeps `Battery.ts`'s `charge` and `ownerOf` maps from being
 *   seeded with an id `playerDropped` will never fire for — the unbounded-map condition
 *   MICA-113/114 closed, by a route those handlers never saw.
 *
 * The local `on('QBCore:Server:PlayerLoaded')` twins are a different event name, are not
 * client-emittable, and keep reading the payload: `qbx_core/server/player.lua:1064` triggers
 * that one in-process with the Player object, where there is no connection to derive an
 * identity from.
 */
export const loadedPlayerSource = (player: unknown): number | undefined => {
  const connection = source;
  if (!Number.isInteger(connection) || connection <= 0) return undefined;

  // Rate limit and authenticate before comparing, so every invocation is counted rather
  // than only the ones that turn out to be honest.
  if (!guardNetEvent(SHELL_SERVICE, 'playerLoaded')) {
    return refuse(
      connection,
      'no loaded character behind it yet, or too many in one minute. If this player never ' +
        'gets their settings or battery, their character is being announced before the ' +
        'framework has registered it'
    );
  }

  const claimed = sourceOf(player);
  if (claimed !== undefined && claimed !== connection) {
    return refuse(connection, `it named source ${claimed} instead of itself`);
  }

  return connection;
};

/**
 * Mirrors `Settings.ts` and `Battery.ts`, including listening for both cores' events,
 * because the shape of the player-loaded event differs between QBCore and qbx and neither
 * is safe to assume. Kept here rather than duplicated a third time, since the push itself
 * is shell-scoped rather than owned by any one app's data.
 *
 * Network, not local, and `onNet` is the only listener this name ever needs.
 *
 * qbx_core fires `QBCore:Server:OnPlayerLoaded` with `TriggerServerEvent` from the client
 * and passes nothing — `qbx_core/client/character.lua:280` and `:482` (v1.24.0, vendored
 * here), and `qbx_spawn/client/main.lua:218` does the same. A plain `on()` here would throw
 * "was not safe for net" the moment a player loads, because `RegisterNetEvent`'s
 * network-safety flag is per-resource: qbx_core declaring the name net-safe for itself does
 * nothing for gPhone's own handler.
 *
 * **Nothing fires this name locally with a Player object.** The local, Player-object
 * trigger is a *different event* — `QBCore:Server:PlayerLoaded`, from
 * `qbx_core/server/player.lua:1064` — and it is the `on()` twin below that handles it. So
 * there is no legitimate caller of *this* name that supplies an identity, which is why
 * taking the target from the connection costs the honest path nothing.
 *
 * Scoped to what is actually on this server: qbx_core is the only core vendored here, and
 * vanilla `qb-core` is not, so its behaviour is not asserted. If it ever fires this name
 * locally with a Player object, that call arrives with `source` 0 and
 * `loadedPlayerSource` refuses it — the `on()` twin is where such a core belongs.
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
