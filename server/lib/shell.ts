// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MessageParams } from './errors';
import { detectFramework, FrameworkBridge } from './FrameworkBridge';
import { s } from '@mica/shared/schema';
import { guardNetEvent } from './netGuard';
import { registerService } from './services';
import { ownedTables, purgeOwnedRows, sweepOrphanedRows } from './orphanSweep';
import { AUDIT_LOG_TABLE } from './AuditLogger';
import { whenSchemaReady } from './schemaReady';
import { SELF_SERVICE_EXCEPT } from '../services/Privacy';
import { traceOf } from './sqlErrors';
import { who } from './who';
import { withoutOwnerKeys } from './replyShape';

/**
 * The shell service — the phone itself, rather than any app on it.
 *
 * Most of its traffic goes one way, from the server out to a player's UI, and everything
 * in this file is that outbound half. It is not the whole service: `services/Capabilities.ts`
 * registers `mica:server:shell:capabilities`, an inbound action answering what this
 * deployment can do so the launcher can hide what it cannot. That lives in its own file
 * rather than here because this one owns the push side and the player-loaded registry; the
 * two halves share only the `shell` name.
 *
 * Declaring the service here is what lets `eventNames.test.ts` check the `<service>` segment
 * against a registry instead of a hard-coded list of names that were "not apps".
 */
const SHELL_SERVICE = registerService('shell');

export interface ShellNotification {
  type?: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  message: string;
  /**
   * MICA-216: keys into the shell's `server` catalog for `title` and `message`, so the
   * client shows them in the player's language. The English stays as the fallback and as
   * what a log shows; `server/__tests__/serverMessages.test.ts` holds each key to the
   * catalog.
   */
  key?: string;
  titleKey?: string;
  params?: MessageParams;
}

/**
 * Raise a toast on a player's phone.
 *
 * Replaces the same `emitNet('mica:client:shell:notify', ...)` written out at five call
 * sites across four files. The event name is derived from the service id in exactly one
 * place, so it cannot drift from what the client listens for.
 */
export const notifyPlayer = (source: number, notification: ShellNotification): void => {
  if (!notification?.message) return;
  // No push carries a citizenid or a phone id (MICA-433).
  emitNet(`mica:client:${SHELL_SERVICE}:notify`, source, withoutOwnerKeys(notification));
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
  emitNet(`mica:client:${SHELL_SERVICE}:rehydrate`, source);
};

/**
 * Every event name that means "a character finished loading", in one place.
 *
 * Exported so `playerLoaded.test.ts` can assert against the real list rather than a copy of
 * it — including the scan that fails the build when one of these names is registered outside
 * this file. Three names, and the difference between them is a security boundary rather than
 * a naming detail:
 *
 * - **`network`** is raised by qbx from the *client*, with `TriggerServerEvent` and no
 *   payload. `onNet`, therefore reachable by any connected client, therefore the connection
 *   is the authority — see `loadedPlayerSource`.
 * - **`qbLocal`** is raised in-process by `qbx_core/server/player.lua:1064` with the Player
 *   object. No client can emit it, so the payload is the identity.
 * - **`esxLocal`** is raised in-process by es_extended: `TriggerEvent('esx:playerLoaded',
 *   playerId, xPlayer, isNew)`. Not a `TriggerServerEvent`, so registering only `on` leaves
 *   the name un-net-safe inside micaOS and no client can reach it. An `onNet` twin added "to
 *   be safe" would manufacture an entry point es_extended does not have.
 * - **`standaloneJoin`** is raised by the **FiveM runtime itself**, not by any framework —
 *   there is no framework on a standalone server to raise anything. It is local, so the same
 *   reasoning as `esxLocal` applies twice over: registering only `on` leaves it un-net-safe
 *   inside micaOS, and unlike the two above it carries no identity in its payload at all.
 *   See the listener for why the connection is the only thing it reads.
 */
export const PLAYER_LOADED_EVENTS = {
  network: 'QBCore:Server:OnPlayerLoaded',
  qbLocal: 'QBCore:Server:PlayerLoaded',
  esxLocal: 'esx:playerLoaded',
  standaloneJoin: 'playerJoining'
} as const;

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
  // A new connection on this id is nobody's switch (MICA-336): see `loadedCharacter`.
  loadedCharacter.delete(source);
  loggedOut.delete(source);
  /**
   * And forget which server id this character was on (MICA-197).
   *
   * Registered here rather than in `FrameworkBridge` so that module keeps having no framework
   * event of its own — the property its own note claims, one direction over. It rides this
   * handler rather than adding a second `playerDropped` listener for the same reason
   * `onPlayerLoaded` is a registry: one listener per event, and everything that cares
   * subscribes to it.
   *
   * FiveM reassigns server ids, so this is not tidiness. A stale entry would address the next
   * player given this id as the one who left, and `Messages.deliverToParticipants` would
   * hand them somebody else's message. The bridge evicts by source on the way in as well, so
   * a missed drop is survivable rather than silent — but this is the event that is supposed
   * to do it.
   */
  FrameworkBridge.forgetSource(source);
});

/**
 * Every event name that means "this character logged out, and the connection stayed"
 * (MICA-382): a multichar logout to character select, for which FiveM fires no
 * `playerDropped`.
 *
 * - **`qbLocal`** is raised in-process, with the server id as its one argument, by qbx_core's
 *   `Logout` (`qbx_core/server/player.lua:747`, vendored here) and — by the same name and
 *   shape — by qb-core's `QBCore.Player.Logout`, which is not vendored here. qbx fires it
 *   *before* the `Wait(200)` that clears the player, which is why the bridge records the
 *   logout rather than only forgetting it; qb-core clears the player straight after firing it.
 *   qbx also fires `qbx_core:server:playerLoggedOut` after that wait; listening to it as well
 *   would forget the same source twice.
 * - **`esxLocal`** is ESX Legacy's `esx:playerLogout`, `(playerId, cb)`, raised in-process by
 *   esx_multicharacter on a relog and answered by es_extended itself, which saves the player
 *   and clears it in the save's callback. Not vendored here; the shape is es_extended's.
 *
 * Both are local, and so are registered with `on` alone, for the reason `esxLocal` above gives:
 * `RegisterNetEvent`'s network-safety flag is per-resource, so a client emitting either name
 * reaches nothing here. That is the whole of the defence that matters — an `onNet` twin would
 * let any client make the server forget another player's source and stop their pushes.
 *
 * Standalone has no characters to log out of; a standalone player leaves only by dropping.
 */
export const PLAYER_UNLOADED_EVENTS = {
  qbLocal: 'QBCore:Server:OnPlayerUnload',
  esxLocal: 'esx:playerLogout'
} as const;

/**
 * The server id an unload event names, or `undefined`. The argument is the identity — no
 * client can reach these names (above) — but it is still only believed as a positive integer,
 * which is what a server id is.
 */
const unloadedSource = (src: unknown): number | undefined =>
  typeof src === 'number' && Number.isInteger(src) && src > 0 ? src : undefined;

/**
 * A character logged out and the connection stayed (MICA-382): end what a character switch ends,
 * now rather than at the next pick, and stop addressing the character who left at this source.
 *
 * - **The `forgetOnPlayerLoaded` forgetters that run at logout** (`endLoggedOutCharacter`): the
 *   call they were on ends for both parties and is filed under them, their speaker goes off
 *   and their stereo stops. A player sitting on character select stayed in the call's voice
 *   channel until they picked again. What belongs to the character rather than the session —
 *   a lock or a signal override a script set on them — waits for a different character's load
 *   (`atLogout: false`), so a relog does not escape it.
 * - **The bridge's registry** (`logOutSource`), so a push addressed to the character who left — a
 *   911 or job-line call, a contact share, a notification — reaches nobody rather than the
 *   character-select screen. The row is written either way; they read it when they load.
 *
 * Forgetters first, while the bridge can still name every other party to the call by source.
 */
const forgetLoggedOut = (src: unknown): void => {
  const id = unloadedSource(src);
  if (id === undefined) return;
  endLoggedOutCharacter(id);
  FrameworkBridge.logOutSource(id);
};

on(PLAYER_UNLOADED_EVENTS.qbLocal, forgetLoggedOut);
on(PLAYER_UNLOADED_EVENTS.esxLocal, forgetLoggedOut);

/**
 * Refuse, and say so once.
 *
 * `guardNetEvent` refuses silently by design — these events carry no callback id, so there
 * is nobody waiting to be told (`lib/netGuard.ts`). That is right for a flood and wrong for
 * the ordering case: under a custom multichar, or a core that announces a character before
 * the framework has registered it, micaOS would simply never rehydrate settings and never
 * load battery, with no output anywhere and every suite still green. Silence that reads as
 * success is the thing the house rules exist to prevent, so this one refusal is audible.
 */
const refuse = (connection: number, why: string): undefined => {
  if (!refusalsLogged.has(connection)) {
    refusalsLogged.add(connection);
    console.warn(`[mica] ignored QBCore:Server:OnPlayerLoaded from source ${connection}: ${why}.`);
  }
  return undefined;
};

/**
 * The one argument a player-loaded packet may carry, declared as `unknown` on purpose.
 *
 * Every raw handler declares its input (MICA-210), and this is the honest declaration for
 * this one: no legitimate emitter sends anything, and whatever does arrive is a *claim*
 * that `loadedPlayerSource` compares against the connection rather than a value it reads.
 * A stricter shape would refuse a forged payload before the comparison could name it in
 * the once-per-connection warning, which is the only reason the payload is looked at.
 */
const PLAYER_LOADED_INPUT = s.tuple([s.unknown()]);

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
  if (!guardNetEvent(SHELL_SERVICE, 'playerLoaded', PLAYER_LOADED_INPUT, [player])) {
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
 * nothing for micaOS's own handler.
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
onNet(PLAYER_LOADED_EVENTS.network, (player: unknown) => {
  const src = loadedPlayerSource(player);
  if (src) dispatchPlayerLoaded(src);
});

/** The local twin. No client can emit this one, so the payload is still the identity. */
on(PLAYER_LOADED_EVENTS.qbLocal, (player: unknown) => {
  const src = sourceOf(player);
  if (src) dispatchPlayerLoaded(src);
});

/**
 * The source out of `esx:playerLoaded`, whose signature is `(playerId, xPlayer, isNew)`.
 *
 * The first argument is the id and is what every es_extended build passes. The xPlayer is
 * read as a fallback because it carries `source` itself, and an ESX fork that reorders or
 * drops the first argument should degrade to working rather than to silence — which is the
 * failure this whole file exists to avoid.
 */
const esxLoadedSource = (playerId: unknown, xPlayer: unknown): number | undefined => {
  const direct = sourceOf(playerId);
  if (direct !== undefined) return direct;
  const carried = (xPlayer as { source?: unknown })?.source;
  return typeof carried === 'number' ? carried : undefined;
};

/**
 * ESX's player-loaded event — and why it is `on` rather than `onNet`.
 *
 * MICA-136's rule is that the connection is the authority and a packet naming somebody
 * else is refused outright. This satisfies it more completely than a guard could, by not
 * offering the packet a way in at all.
 *
 * es_extended fires this **server-side and locally**: `TriggerEvent('esx:playerLoaded',
 * playerId, xPlayer, isNew)`. It is not a `TriggerServerEvent`, which is the whole reason
 * qbx's `QBCore:Server:OnPlayerLoaded` had to be `onNet` and had to be hardened. And
 * `RegisterNetEvent`'s network-safety flag is per-resource — the fact this file already
 * relies on, one direction over — so micaOS registering only `on` means this name is *not*
 * net-safe inside micaOS and a client emitting it reaches nothing here. There is no forged
 * target to refuse, and so no `loadedPlayerSource` on this path.
 *
 * Adding an `onNet` twin "to be safe" would do the opposite: it would declare the name
 * net-safe for micaOS and manufacture a client-reachable entry point that es_extended does
 * not have. §2.9's rule against registering an action the app does not use applies to a
 * framework-named event exactly as it does to a mica-named one — `docs/security.md`
 * records that a census organised by mica event names is how this category got missed
 * before. If a fork is ever found firing this name from a client, the fix is an `onNet`
 * twin routed through `loadedPlayerSource`, not a payload read.
 *
 * The payload is therefore the identity here, on the same terms as the
 * `QBCore:Server:PlayerLoaded` twin above.
 *
 * Like the two above it, this resolves a source and hands it to `dispatchPlayerLoaded`. It is
 * the resolution that differs per entry point and the dispatch that is shared — see the
 * registry's own note on why those two halves must not be merged.
 */
on(PLAYER_LOADED_EVENTS.esxLocal, (playerId: unknown, xPlayer: unknown) => {
  const src = esxLoadedSource(playerId, xPlayer);
  if (src) dispatchPlayerLoaded(src);
});

/**
 * Standalone's player-loaded event — **the connection itself, because there is nothing else**.
 *
 * A standalone server has no framework, so no character is ever "loaded": nothing announces
 * one, nothing has a Player object to announce, and the three listeners above will never fire
 * for the rest of this resource's life. What does happen is that somebody connects, and on a
 * standalone server that *is* the whole of the event — one player, one identity, established
 * by `FrameworkBridge.getPlayer` from their license the moment they have a server id.
 *
 * `playerJoining` is raised by the FiveM runtime itself when a connecting client is assigned
 * that id, with `source` set to it. Three properties matter, and they are the reason this is
 * the right name rather than an invented one:
 *
 * - **It already exists.** §2.9's rule against registering an action the app does not use
 *   applies to a runtime-named event exactly as it does to a mica-named one, and the
 *   inverse applies here: micaOS listens to something the runtime already raises rather than
 *   asking the client to announce itself. A `mica:server:shell:ready` would have been a new
 *   client-reachable entry point, on the one path whose whole job is establishing identity.
 * - **`on`, never `onNet`.** The runtime raises it in-process, so registering only `on`
 *   leaves the name un-net-safe inside micaOS (`RegisterNetEvent`'s flag is per-resource —
 *   the fact `esxLocal` relies on, one direction over) and a client emitting it reaches
 *   nothing here.
 * - **The payload is not read, and there is nothing in it to read.** `playerJoining`'s only
 *   argument is the player's *old* id from a server-transfer, which is not an identity and is
 *   not this player's. MICA-136's rule is that the connection is the authority; here the
 *   connection is also the only thing on offer, so the rule costs nothing and cannot be
 *   forgotten.
 *
 * Gated on `detectFramework()` answering `standalone`, which is only ever true when the
 * operator set `mica_standalone` and no framework answered. On a qb or ESX server this
 * fires for every join and returns immediately — the framework's own event is what dispatches
 * there, and dispatching twice would rehydrate a phone whose character has not loaded yet.
 *
 * **What this cannot promise is that the player's client is listening yet.** `playerJoining`
 * is early, and a subscriber's `emitNet` may land before the client has registered its
 * handlers. That is survivable by construction rather than by luck: every subscriber here
 * pushes state the phone also fetches for itself when it opens, so a lost push costs a
 * refresh and never a wrong value. The half that has to happen at join — resolving the
 * identity and warming what hangs off it — happens server-side and is unaffected.
 */
on(PLAYER_LOADED_EVENTS.standaloneJoin, () => {
  if (detectFramework() !== 'standalone') return;

  const connection = source;
  if (!Number.isInteger(connection) || connection <= 0) return;

  dispatchPlayerLoaded(connection);
});

/** Anything that wants to know a character has loaded. */
type PlayerLoadedRun = (src: number) => void | Promise<void>;

interface PlayerLoadedSubscriber {
  /** Named only so a throw can say which one threw. */
  name: string;
  run: PlayerLoadedRun;
}

const playerLoadedSubscribers: PlayerLoadedSubscriber[] = [];

/**
 * Be told when a character has loaded, without registering a framework event yourself.
 *
 * **Why a registry rather than three modules each writing their own listener.** There were
 * three player-loaded listeners across `lib/shell.ts`, `services/Settings.ts` and
 * `services/Battery.ts`, each pasted from the last. Every one of them took the target out of
 * the payload, so a modified client could name a third party and have their state rehydrated,
 * re-read and overwritten — MICA-136, fixed in three places at once because the mistake had
 * been made in three places at once. Adding ESX meant a fourth listener per module, and the
 * next framework a fifth. A subscriber cannot get the identity wrong because it is never
 * shown anything to get wrong: it is handed a source that has already been established.
 *
 * **The two paths stay separate, and that is the point rather than an implementation
 * detail.** Resolution belongs to each entry point — the network listener goes through
 * `loadedPlayerSource`, where the connection is the authority and a payload naming somebody
 * else is refused; the two local listeners read the payload, because no client can reach them
 * and the payload is all there is. Only the already-resolved source reaches here. Collapsing
 * those into one lenient resolver is precisely the bug MICA-136 fixed, and it would now be
 * three subscribers deep instead of one.
 *
 * Registration order is import order, and nothing here depends on it: subscribers do
 * unrelated work and none reads another's result.
 */
export const onPlayerLoaded = (name: string, run: PlayerLoadedRun): void => {
  playerLoadedSubscribers.push({ name, run });
};

/**
 * Forget what a source held for the character that was on it before. Synchronous. Handed that
 * character's citizenid, for anything that still has to be filed under them on the way out.
 */
type SourceForget = (src: number, previousCitizenid: string) => void;

interface SourceForgetter {
  /** Named only so a throw can say which one threw. */
  name: string;
  forget: SourceForget;
  /** Whether it runs when the character logs out, rather than when the next one loads. */
  atLogout: boolean;
}

/** When a forgetter may run. See `forgetOnPlayerLoaded`. */
interface ForgetOptions {
  /**
   * `false` keeps a forgetter to the next character's load, for one that is only right once
   * that character is known. Defaults to `true`.
   */
  atLogout?: boolean;
}

const playerLoadedForgetters: SourceForgetter[] = [];

/**
 * Forget source-keyed state when a **different** character loads on a source, before any
 * subscriber runs (MICA-336).
 *
 * A character load on a source that is already connected can be a character switch — a
 * multichar logout and pick — and FiveM fires no `playerDropped` for it. So everything keyed by
 * source and cleared only on drop still names the previous character when the next one loads:
 * the slot they last used a phone from, the call they were on. Battery's `phoneOf` was the first
 * of these found (MICA-326).
 *
 * **At logout too, where the framework says so (MICA-382).** A framework that fires an unload
 * event (`PLAYER_UNLOADED_EVENTS`) runs every forgetter registered with `atLogout` — the
 * default — when the character logs out, so a call does not stay live while its party sits on
 * character select. Those registered `atLogout: false` are only right once the next character
 * is known, and wait for the load.
 *
 * **And every forgetter again when a different character loads**, logout or not. The frameworks
 * still name the character for a moment after announcing the unload — qbx's `Wait(200)`, ESX's
 * save; qb-core clears them at once — so a slot or a call can be recorded for them after their
 * logout forgetters ran, and the next character would inherit it. So an `atLogout` forgetter **must be idempotent**: by the
 * second run there is normally nothing left, and it must do nothing then — no second `ended`, no
 * second call-log row. The same character picked again is not a switch and runs nothing.
 *
 * A phase of its own rather than an ordinary subscriber, because subscribers run in import
 * order and read each other's state: a subscriber that resolves a device ahead of the one
 * that forgets the last-used slot would resolve the previous character's phone. Every
 * forgetter runs first, so no subscriber can be handed state from before the load.
 *
 * **Only on a switch.** A load is announced more than once: qbx fires the local
 * `QBCore:Server:PlayerLoaded` inside its character load, and the network
 * `QBCore:Server:OnPlayerLoaded` only once the player confirms a spawn in qbx_spawn — with no
 * time limit, while the character is loaded, has a number, and can be rung (the client opens
 * the phone for an incoming call). Forgetting on that second announcement ended a call answered
 * on the spawn screen. So `dispatchPlayerLoaded` runs forgetters only when the character it is
 * loading differs from the one the shell last dispatched on the source (`loadedCharacter`,
 * deliberately not the bridge's registry); a first load since connecting, and a player
 * re-sending the network event for themselves, both forget nothing.
 *
 * State that belongs to the connection rather than the character — rate windows, what the
 * client was last told — is not registered at all.
 */
export const forgetOnPlayerLoaded = (
  name: string,
  forget: SourceForget,
  options: ForgetOptions = {}
): void => {
  playerLoadedForgetters.push({ name, forget, atLogout: options.atLogout ?? true });
};

/**
 * The character the shell last dispatched as loaded on each source (MICA-336), which is what a
 * load compares against to tell a switch from the same character announced again.
 *
 * **The shell's own, and nothing rebuilds it.** `FrameworkBridge` keeps a source registry too,
 * but rebuilds it from the framework on any lookup that misses (`reseedSources`), and the
 * framework's answer is wrong at both ends of a qbx switch: logout empties `QBX.Players[src]`
 * while the player sits on character select, so a rebuild there forgets who left; and login
 * seats the new character and awaits before announcing it, so a rebuild there records them
 * early. Either way the next load looked like no switch at all. Set here, after the
 * forgetters run, and at a logout that names a character it had not seen load (a resource
 * restart since); cleared only by `playerDropped`. A logout keeps it, so the next load still
 * tells a switch from the same character picked again.
 */
const loadedCharacter = new Map<number, string>();

/**
 * Sources whose character's logout already ran the `atLogout` forgetters (MICA-382), so a second
 * unload event for the same logout runs nothing. Cleared by the next load that names a
 * character, and by `playerDropped`, so bounded by the connected players.
 */
const loggedOut = new Set<number>();

/**
 * The character a load replaces, or null when it replaces nobody: nobody dispatched on the
 * source since it connected, or the same character announced again.
 */
const replacedCharacter = (src: number, current: string | undefined): string | null => {
  const previous = loadedCharacter.get(src);
  return previous !== undefined && current && current !== previous ? previous : null;
};

/**
 * Every forgetter `which` selects, each its own failure, for a source whose character `previous`
 * was.
 */
const forgetCharacter = (
  src: number,
  previous: string,
  which: (forgetter: SourceForgetter) => boolean
): void => {
  for (const forgetter of playerLoadedForgetters) {
    if (!which(forgetter)) continue;
    const { name, forget } = forgetter;
    try {
      forget(src, previous);
    } catch (error) {
      console.error(
        `[mica] player-loaded forgetter '${name}' threw for source ${src}. The previous ` +
          `character's state it holds may still be visible; the rest still ran.`,
        traceOf(error)
      );
    }
  }
};

const atLogout = (forgetter: SourceForgetter): boolean => forgetter.atLogout;
const everyForgetter = (): boolean => true;

/**
 * The logout half of a switch (MICA-382): the `atLogout` forgetters, handed the character who
 * logged out.
 *
 * That character is the one the shell last dispatched on the source or, when it never saw them
 * load (a resource restart since), the one the framework still names: both frameworks announce
 * the unload before they clear the player. Recorded as `loadedCharacter` in that case, so the
 * next load is still recognised as a switch and runs the load-only forgetters. A source with no
 * character to name has nothing to forget.
 */
const endLoggedOutCharacter = (src: number): void => {
  if (loggedOut.has(src)) return;
  const previous = loadedCharacter.get(src) ?? FrameworkBridge.getPlayer(src)?.citizenid;
  if (!previous) return;
  loggedOut.add(src);
  loadedCharacter.set(src, previous);
  forgetCharacter(src, previous, atLogout);
};

/**
 * Run every subscriber for a source that has already been established.
 *
 * **One subscriber failing must not take the others with it, and must not fail the load.**
 * A synchronous throw is caught here; a rejected promise is caught on the promise, because
 * `Battery`'s subscriber is async and a `void`-ed rejection would otherwise surface as an
 * unhandled rejection with nothing naming the subscriber. Either way the remaining
 * subscribers still run, this returns normally, and the framework's own player-load path is
 * untouched — micaOS has no way to fail a character load and must not invent one. The cost
 * is that a broken subscriber is degraded rather than fatal, which is why it is logged with
 * its name: silence that reads as success is the failure mode this repo cares most about.
 */
const dispatchPlayerLoaded = (src: number): void => {
  const current = FrameworkBridge.getPlayer(src)?.citizenid;
  if (current) {
    // Only a load that names a character ends a logout: one the framework will not name yet
    // is announced again, and the logout stays recorded until then.
    loggedOut.delete(src);
    // Every forgetter, after a logout too: see `forgetOnPlayerLoaded` for why they run again.
    const previous = replacedCharacter(src, current);
    if (previous !== null) forgetCharacter(src, previous, everyForgetter);
    loadedCharacter.set(src, current);
  }
  for (const subscriber of playerLoadedSubscribers) {
    try {
      const pending = subscriber.run(src);
      if (pending && typeof pending.then === 'function') {
        void pending.catch((error: unknown) => {
          console.error(
            `[mica] player-loaded subscriber '${subscriber.name}' rejected for source ${src}. ` +
              `The other subscribers still ran.`,
            traceOf(error)
          );
        });
      }
    } catch (error) {
      console.error(
        `[mica] player-loaded subscriber '${subscriber.name}' threw for source ${src}. ` +
          `The other subscribers still ran.`,
        traceOf(error)
      );
    }
  }
};

/**
 * The shell's own subscription, registered here rather than called directly from the three
 * listeners so that it goes through exactly the path `Settings` and `Battery` do. A special
 * case for the owner of the registry is how the owner's path stops being tested.
 */
onPlayerLoaded('shell', pushRehydrate);

/**
 * Record which server id this character loaded on (MICA-197).
 *
 * A subscriber rather than a listener inside `FrameworkBridge`, so the bridge is handed a
 * source that has already been established by whichever entry point resolved it — the network
 * one through `loadedPlayerSource`, where the connection is the authority, and the three local
 * ones from their payloads. A registry filled from a payload nobody had vetted is precisely
 * MICA-136, and this is the one map in the resource where being wrong means delivering a
 * private message to the wrong player.
 *
 * Registered after `'shell'` and before nothing in particular: no subscriber reads another's
 * result, and the bridge reconciles a cold registry against the framework on its own anyway —
 * which is what covers the case this hook structurally cannot, a resource restart with players
 * already connected and no character left to load.
 */
onPlayerLoaded('framework-sources', FrameworkBridge.rememberSource);

/**
 * What outlives a deleted character (MICA-300): the reports they filed that staff have not
 * resolved yet, which keep holding the content they name, and their rows in the moderation
 * ledger, permanently — the record of a staff member's moderation outlives the staff member.
 *
 * **And the device rows, live** (MICA-428). They are the phone's identity and state, not the
 * character's content, and the phone item can outlive its character: the next holder's
 * resolve reads its `mica_devices` row as `active`, finds none if it was erased, and its
 * create is refused by `device_id_unique` — a phone that never works again. Left `active`, the
 * row is handed on by the handover walk like any phone that changes hands. Before MICA-428 the
 * purge deleted them and the next resolve minted the row afresh.
 *
 * Everything else they owned is erased. The entries are a player's own delete's, taken from
 * `SELF_SERVICE_EXCEPT` rather than restated, so the pending-report predicate cannot drift
 * between the two. Taking them by name is checked loudly: a rename there that dropped one would
 * otherwise erase it with nothing said (`orphanSweep.test.ts` holds it too).
 */
const CHARACTER_KEEPS = [
  AUDIT_LOG_TABLE,
  'mica_reports',
  'mica_devices',
  'mica_phone_numbers',
  'mica_battery',
  'mica_lockscreen'
];
export const CHARACTER_EXCEPT = SELF_SERVICE_EXCEPT.filter(({ table }) =>
  CHARACTER_KEEPS.includes(table)
);
if (CHARACTER_EXCEPT.length !== CHARACTER_KEEPS.length) {
  console.error(
    `[mica] a deleted character's ${CHARACTER_KEEPS.join(', ')} rows should be kept, but ` +
      "Privacy's SELF_SERVICE_EXCEPT no longer names them all; they will be erased."
  );
}

/**
 * The character-deleted purge and the start-up sweep, as their hooks below run them: the write
 * in `orphanSweep.ts`, leaving `CHARACTER_EXCEPT` as it is.
 *
 * **Both leave the same rows**, and the sweep's copy is not optional: with no foreign key onto
 * the owner, a kept report is an orphan like any other at the next start. A pending report is
 * erased once it resolves; a ledger row never is.
 */
export const purgeDeletedCharacter = (citizenid: string) =>
  purgeOwnedRows(citizenid, {
    except: CHARACTER_EXCEPT,
    purpose: 'for a deleted character'
  });
export const sweepDeletedCharacters = () => sweepOrphanedRows({ except: CHARACTER_EXCEPT });

/**
 * Told that a character is gone, erase its rows in every table that owned any (MICA-428).
 *
 * **`on`, never `onNet`, and the distinction is the security boundary.** `onNet` would
 * register this as a net event, and a registered net event is reachable by a modified
 * client (§2.9) — which would hand any player a one-argument erase of any other player's
 * entire phone, across thirty tables. `on` registers a local handler only, so the sole
 * way to reach it is a trigger from another **server** resource, which is code the owner
 * installed. `mediaRetention.test.ts` has asserted exactly this for the media hook since
 * MICA-71 and `orphanSweep.test.ts` asserts it here; that assertion is the one thing that
 * catches an `onNet` slip, so it is carried across rather than paraphrased.
 *
 * micaOS owns the name rather than listening for a framework's, for the reason
 * `services/Media.ts` gives at length: qb-core, qbx_core and es_extended do not agree on
 * what they emit when a character is deleted, several multicharacter resources emit
 * nothing, and a handler for a guessed name is cleanup that silently never runs — which
 * reads exactly like cleanup that works.
 *
 * **The older `mica:server:media:characterDeleted` is left alone, doing exactly what it
 * documented.** Widening it to a whole-phone purge would have been free reach for owners
 * already wired to it, and that is the argument against it: the README also describes it as
 * a way to reclaim media *space*, so somebody firing it at a character who still exists
 * would silently lose that character's messages and contacts too. Deleting more than the
 * caller asked for is the failure this ticket exists to prevent, not a bonus. Owners wired
 * to the old name keep media cleanup at once and get the other twenty-one tables at the
 * next restart's sweep, which is strictly better than they had.
 *
 * **Since MICA-300 this and the sweep below are the only cleanup there is**, on qb as on ESX:
 * the foreign keys onto `players` that used to cascade are gone, so the framework deleting a
 * character leaves micaOS's rows in place for this to decide over. It erases with the write a
 * player's own delete uses (`purgeDeletedCharacter`), keeping less live: every row of the
 * character's moves to `erased`, except their pending reports, moderation ledger rows and
 * device rows (`CHARACTER_EXCEPT`) and a takedown's `moderated` row.
 */
on(`mica:server:${SHELL_SERVICE}:characterDeleted`, (rawCitizenid: unknown) => {
  const citizenid = typeof rawCitizenid === 'string' ? rawCitizenid.trim() : '';
  if (citizenid.length === 0) return;

  void purgeDeletedCharacter(citizenid)
    .then(({ erased, kept, failures }) => {
      // Unconditionally, including zero, for the reason the start-up sweep below gives at
      // length: a query issued while oxmysql has no pool hangs rather than failing, so an
      // outcome logged only when there was something to say cannot be told apart from one
      // that never returned. An operator triggering this deliberately needs the difference.
      console.log(
        `[mica] erased ${erased} row(s) for deleted character ${who(citizenid)}` +
          (kept > 0 ? `, left ${kept} under a takedown or kept live.` : '.')
      );
      // Each failure is logged where it happened, in `purgeOwnedRows`; this is the count.
      if (failures.length > 0) {
        console.error(
          `[mica] purge for ${who(citizenid)} failed on ${failures.length} table(s): ` +
            failures.map(({ table }) => table).join(', ')
        );
      }
    })
    .catch((error) => {
      console.error('[mica] purge for a deleted character failed:', traceOf(error));
    });
});

/**
 * The backstop: sweep at every resource start.
 *
 * A hook is what keeps a busy server tidy between restarts, and it only fires on the
 * servers whose owner wired it up. This is what covers everyone else — and since MICA-300,
 * with no framework's schema cascading any more, it is the only thing standing between a
 * deleted character's rows staying live forever. It leaves what the purge above leaves, and
 * erases a pending report once it resolves.
 *
 * `onResourceStart` rather than module scope, matching `Schema.ts` and `Media.ts`: it fires
 * after the whole controller graph has imported, so `declaredServices` is complete and the
 * derived table set is the real one. Reading it at module scope would sweep only the
 * services that happened to import first — a sweep that silently covers a subset is worse
 * than none, because its log line says it ran.
 *
 * Failure is logged, never thrown. Maintenance must not be able to stop the resource
 * starting, and nothing is waiting on this: no player is connected yet.
 *
 * **It says it is starting before its own first query, and says it finished even when it
 * erased nothing.** (The first-start schema check, which it waits for, asks first and logs for
 * itself.) Both halves are load-bearing, and the reason is specific rather
 * than tidiness. oxmysql's `rawQuery` does `await using connection = await getConnection();
 * if (!connection) return;` without ever invoking the callback, so a query issued before the
 * pool is up **neither resolves nor rejects** — it hangs, and `lib/Database.ts` has no
 * timeout. This hook can fire in exactly that window. A hang is safe from erasing anything,
 * which is the half that matters, but a sweep that logged only its results would be
 * indistinguishable from one that ran and found nothing: silence that reads as success, the
 * failure this repo cares most about. A `starting` line with no `finished` line after it is
 * an operator's evidence that the sweep never got past its first query.
 *
 * The timeout that would actually fix the hang belongs in `Database`, not here — every
 * `await Database.*` in the resource has it, and solving it locally is what left
 * `HodlrMarket.restorePrice` as the only caller that recovers.
 *
 * `mica_media` is swept twice at start — once here and once by `runMediaMaintenance`,
 * which also runs the retention prune and reports the pair. That is deliberate. The second
 * `UPDATE … WHERE NOT EXISTS` over a table just swept moves nothing, and making either
 * conditional on the other would couple two lifecycles to save one no-op statement.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;
  // After the schema has settled (MICA-306): a fresh install's tables may still be being
  // created, and there is nothing to sweep on a database whose create was refused. The
  // `starting` line is still said before the sweep's first query.
  whenSchemaReady(() => {
    const tables = ownedTables().length;
    console.log(`[mica] orphan sweep starting over ${tables} table(s).`);

    void sweepDeletedCharacters()
      .then(({ erased, kept, byTable, failures }) => {
        const detail = Object.entries(byTable)
          .map(([table, count]) => `${table} ${count}`)
          .join(', ');
        console.log(
          `[mica] orphan sweep finished: erased ${erased} row(s)${detail ? ` (${detail})` : ''}` +
            (kept > 0 ? `, left ${kept} under a takedown or kept live.` : '.')
        );
        // Each failure is logged where it happened, in `sweepOrphanedRows`; this is the count.
        if (failures.length > 0) {
          console.error(
            `[mica] orphan sweep failed on ${failures.length} table(s): ` +
              failures.map(({ table }) => table).join(', ')
          );
        }
      })
      .catch((error) => {
        console.error('[mica] orphan sweep failed:', traceOf(error));
      });
  });
});
