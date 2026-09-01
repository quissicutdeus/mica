// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { detectFramework } from './FrameworkBridge';
import { guardNetEvent } from './netGuard';
import { registerService } from './services';
import { ownedTables, purgeOwnedRows, sweepOrphanedRows } from './orphanSweep';

/**
 * The shell service — the phone itself, rather than any app on it.
 *
 * Most of its traffic goes one way, from the server out to a player's UI, and everything
 * in this file is that outbound half. It is not the whole service: `services/Capabilities.ts`
 * registers `gphone:server:shell:capabilities`, an inbound action answering what this
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
 *   the name un-net-safe inside gPhone and no client can reach it. An `onNet` twin added "to
 *   be safe" would manufacture an entry point es_extended does not have.
 * - **`standaloneJoin`** is raised by the **FiveM runtime itself**, not by any framework —
 *   there is no framework on a standalone server to raise anything. It is local, so the same
 *   reasoning as `esxLocal` applies twice over: registering only `on` leaves it un-net-safe
 *   inside gPhone, and unlike the two above it carries no identity in its payload at all.
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
 * relies on, one direction over — so gPhone registering only `on` means this name is *not*
 * net-safe inside gPhone and a client emitting it reaches nothing here. There is no forged
 * target to refuse, and so no `loadedPlayerSource` on this path.
 *
 * Adding an `onNet` twin "to be safe" would do the opposite: it would declare the name
 * net-safe for gPhone and manufacture a client-reachable entry point that es_extended does
 * not have. §2.9's rule against registering an action the app does not use applies to a
 * framework-named event exactly as it does to a gphone-named one — `docs/security.md`
 * records that a census organised by gphone event names is how this category got missed
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
 *   applies to a runtime-named event exactly as it does to a gphone-named one, and the
 *   inverse applies here: gPhone listens to something the runtime already raises rather than
 *   asking the client to announce itself. A `gphone:server:shell:ready` would have been a new
 *   client-reachable entry point, on the one path whose whole job is establishing identity.
 * - **`on`, never `onNet`.** The runtime raises it in-process, so registering only `on`
 *   leaves the name un-net-safe inside gPhone (`RegisterNetEvent`'s flag is per-resource —
 *   the fact `esxLocal` relies on, one direction over) and a client emitting it reaches
 *   nothing here.
 * - **The payload is not read, and there is nothing in it to read.** `playerJoining`'s only
 *   argument is the player's *old* id from a server-transfer, which is not an identity and is
 *   not this player's. MICA-136's rule is that the connection is the authority; here the
 *   connection is also the only thing on offer, so the rule costs nothing and cannot be
 *   forgotten.
 *
 * Gated on `detectFramework()` answering `standalone`, which is only ever true when the
 * operator set `gphone_standalone` and no framework answered. On a qb or ESX server this
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
 * Run every subscriber for a source that has already been established.
 *
 * **One subscriber failing must not take the others with it, and must not fail the load.**
 * A synchronous throw is caught here; a rejected promise is caught on the promise, because
 * `Battery`'s subscriber is async and a `void`-ed rejection would otherwise surface as an
 * unhandled rejection with nothing naming the subscriber. Either way the remaining
 * subscribers still run, this returns normally, and the framework's own player-load path is
 * untouched — gPhone has no way to fail a character load and must not invent one. The cost
 * is that a broken subscriber is degraded rather than fatal, which is why it is logged with
 * its name: silence that reads as success is the failure mode this repo cares most about.
 */
const dispatchPlayerLoaded = (src: number): void => {
  for (const subscriber of playerLoadedSubscribers) {
    try {
      const pending = subscriber.run(src);
      if (pending && typeof pending.then === 'function') {
        void pending.catch((error: unknown) => {
          console.error(
            `[gphone] player-loaded subscriber '${subscriber.name}' rejected for source ${src}. ` +
              `The other subscribers still ran.`,
            error
          );
        });
      }
    } catch (error) {
      console.error(
        `[gphone] player-loaded subscriber '${subscriber.name}' threw for source ${src}. ` +
          `The other subscribers still ran.`,
        error
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
 * Told that a character is gone, remove its rows from every table that owned any.
 *
 * **`on`, never `onNet`, and the distinction is the security boundary.** `onNet` would
 * register this as a net event, and a registered net event is reachable by a modified
 * client (§2.9) — which would hand any player a one-argument purge of any other player's
 * entire phone, across twenty-two tables. `on` registers a local handler only, so the sole
 * way to reach it is a trigger from another **server** resource, which is code the owner
 * installed. `mediaRetention.test.ts` has asserted exactly this for the media hook since
 * MICA-71 and `orphanSweep.test.ts` asserts it here; that assertion is the one thing that
 * catches an `onNet` slip, so it is carried across rather than paraphrased.
 *
 * gPhone owns the name rather than listening for a framework's, for the reason
 * `services/Media.ts` gives at length: qb-core, qbx_core and es_extended do not agree on
 * what they emit when a character is deleted, several multicharacter resources emit
 * nothing, and a handler for a guessed name is cleanup that silently never runs — which
 * reads exactly like cleanup that works.
 *
 * **The older `gphone:server:media:characterDeleted` is left alone, doing exactly what it
 * documented.** Widening it to a whole-phone purge would have been free reach for owners
 * already wired to it, and that is the argument against it: the README also describes it as
 * a way to reclaim media *space*, so somebody firing it at a character who still exists
 * would silently lose that character's messages and contacts too. Deleting more than the
 * caller asked for is the failure this ticket exists to prevent, not a bonus. Owners wired
 * to the old name keep media cleanup at once and get the other twenty-one tables at the
 * next restart's sweep, which is strictly better than they had.
 */
on(`gphone:server:${SHELL_SERVICE}:characterDeleted`, (rawCitizenid: unknown) => {
  const citizenid = typeof rawCitizenid === 'string' ? rawCitizenid.trim() : '';
  if (citizenid.length === 0) return;

  void purgeOwnedRows(citizenid)
    .then(({ removed, failures }) => {
      // Unconditionally, including zero, for the reason the start-up sweep below gives at
      // length: a query issued while oxmysql has no pool hangs rather than failing, so an
      // outcome logged only when there was something to say cannot be told apart from one
      // that never returned. An operator triggering this deliberately needs the difference.
      console.log(`[gphone] purged ${removed} row(s) for deleted character ${citizenid}.`);
      for (const { table, error } of failures) {
        console.error(`[gphone] could not purge ${table} for ${citizenid}:`, error);
      }
    })
    .catch((error) => {
      console.error('[gphone] purge for a deleted character failed:', error);
    });
});

/**
 * The backstop: sweep at every resource start.
 *
 * A hook is what keeps a busy server tidy between restarts, and it only fires on the
 * servers whose owner wired it up. This is what covers everyone else — and on ESX, where
 * the schema has no cascade at all, it is the only thing standing between a deleted
 * character and rows that live forever.
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
 * **It says it is starting before it asks the database anything, and says it finished even
 * when it removed nothing.** Both halves are load-bearing, and the reason is specific rather
 * than tidiness. oxmysql's `rawQuery` does `await using connection = await getConnection();
 * if (!connection) return;` without ever invoking the callback, so a query issued before the
 * pool is up **neither resolves nor rejects** — it hangs, and `lib/Database.ts` has no
 * timeout. This hook can fire in exactly that window. A hang is safe from deleting anything,
 * which is the half that matters, but a sweep that logged only its results would be
 * indistinguishable from one that ran and found nothing: silence that reads as success, the
 * failure this repo cares most about. A `starting` line with no `finished` line after it is
 * an operator's evidence that the sweep never got past its first query.
 *
 * The timeout that would actually fix the hang belongs in `Database`, not here — every
 * `await Database.*` in the resource has it, and solving it locally is what left
 * `HodlrMarket.restorePrice` as the only caller that recovers.
 *
 * `gphone_media` is swept twice at start — once here and once by `runMediaMaintenance`,
 * which also runs the retention prune and reports the pair. That is deliberate. The second
 * `DELETE … WHERE NOT EXISTS` over a table just swept removes nothing, and making either
 * conditional on the other would couple two lifecycles to save one no-op statement.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;

  const tables = ownedTables().length;
  console.log(`[gphone] orphan sweep starting over ${tables} table(s).`);

  void sweepOrphanedRows()
    .then(({ removed, byTable, failures }) => {
      const detail = Object.entries(byTable)
        .map(([table, count]) => `${table} ${count}`)
        .join(', ');
      console.log(
        `[gphone] orphan sweep finished: removed ${removed} row(s)${detail ? ` (${detail})` : ''}.`
      );
      for (const { table, error } of failures) {
        console.error(`[gphone] orphan sweep could not read ${table}:`, error);
      }
    })
    .catch((error) => {
      console.error('[gphone] orphan sweep failed:', error);
    });
});
