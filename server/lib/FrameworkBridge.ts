// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdFromIdentifier, CITIZENID_MAX_LENGTH } from '@mica/shared/framework';
import { esxAdapter } from './framework/esx';
import { qbAdapter } from './framework/qb';
import { qbxAdapter } from './framework/qbx';
import { reportStandaloneConflict, standaloneAdapter } from './framework/standalone';
import {
  countInventoryItem as countItemThroughInventory,
  dropOn,
  heldUntilRestart,
  NO_JOB_SUPPORT,
  removeInventoryItem as removeItemThroughInventory,
  type FrameworkAdapter,
  type FrameworkIdentity,
  type FrameworkKind,
  type FrameworkPlayer,
  type JobSupport,
  type OwnerTable
} from './framework/runtime';
import { readItemSlots, writeItemMetadata, type ItemSlot } from './framework/itemMetadata';
import { citizenIdForNumber } from './phoneNumbers';
import { setOwnerTableResolver } from './ownerWidth';
import { traceOf } from './sqlErrors';
import { who } from './who';

/**
 * The one door every framework question goes through.
 *
 * Everything under `framework/` used to be in this file — four frameworks' worth of
 * branches interleaved across nine methods, eighteen hundred lines, and adding a fifth
 * meant reading all four to find where its branches went. Each framework now has its own
 * file exporting a `FrameworkAdapter`, and this picks between them (MICA-197).
 *
 * **The public static surface is unchanged**, deliberately: twenty-odd modules across
 * `server/` import this class and none of them had to move.
 *
 * **Which adapter serves a call is decided per method**, because that is what the branch
 * chains this replaces did: `getPlayer` probed `qbx_core.GetPlayer`, `getAllPlayers` probed
 * `qbx_core.GetQBPlayers`, and `registerUsableItem` probed `qbx_core.CreateUseableItem` —
 * three separate exports, each asked for immediately before it was called. A FiveM resource
 * exposes each of its exports independently, so a build offering one and not another has to
 * keep falling through to the next core; `FrameworkBridge.test.ts` pins exactly that with a
 * qbx fake exposing only `GetQBPlayers`. See `serving`.
 *
 * Once an adapter is chosen for a call it is **committed to**: a `null` from `getPlayer`
 * after that means "not loaded", never "try the next core", which is what the old `if (!player)
 * return null` inside each branch said.
 */

export { citizenIdFromIdentifier, CITIZENID_MAX_LENGTH };
export type {
  FrameworkAdapter,
  FrameworkIdentity,
  FrameworkKind,
  FrameworkPlayer,
  JobSupport,
  OwnerTable
};
export { __setResourceLookup, __resetOfflineLookupWarnings } from './framework/runtime';
export { __resetEsxMetaWarning, __resetEsxPhoneColumn } from './framework/esx';
export { STANDALONE_CONVAR, __resetStandaloneWarnings } from './framework/standalone';

/**
 * The frameworks, in the order they are asked.
 *
 * **The order is a compatibility decision, not a preference.** A qb core wins over
 * es_extended when both are installed, because a live server does not change which string
 * it calls a citizenid on the strength of a second resource being present — that would
 * re-key every row its players own. qbx before qb-core for the same reason, one core over.
 *
 * Standalone is not in this list: it is never *detected*, only asked for. See below.
 */
const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [qbxAdapter, qbAdapter, esxAdapter];

/** The first real framework answering on this server, or null. */
const runningFramework = (): FrameworkAdapter | null => {
  for (const adapter of FRAMEWORK_ADAPTERS) {
    if (adapter.detect()) return adapter;
  }
  return null;
};

/**
 * The resources whose starting or stopping can change which adapter answers (MICA-352).
 *
 * Every adapter's probes ask one of these, plus standalone's convar. A remembered answer is
 * dropped whenever any of them starts or stops, so a core that comes up after micaOS — the
 * boot window `detectFramework` describes — is found on the next call.
 */
const CORE_RESOURCES = ['qbx_core', 'qb-core', 'es_extended'] as const;

/**
 * Remember a positive answer until a core starts or stops; never remember `null` (MICA-352).
 *
 * The probes cost real work per call: FiveM's `exports` proxy caches only exports that exist,
 * so a probe for a missing one throws, and is caught, **every time**. That was one failed
 * probe per `getPlayer` on qb-core, two on ESX, and about six on standalone, where
 * `detectFramework` re-ran all three plus a `GetConvar`.
 *
 * `null` is never held, because it is the answer that changes without a start or stop event
 * we can rely on: "nothing answers yet" during the boot window, and an ESX shared object that
 * exists before it has `GetPlayerFromId` (the MICA-351 review). Each is asked again on the
 * next call, exactly as before. A positive answer can only go stale when a core starts or
 * stops, and that drops it.
 *
 * `standalone` is held like any other positive answer, so the `mica_standalone` convar is
 * read once rather than per call: changing it on a running server takes effect at the next
 * start or stop of a core, or of micaOS. It is a server.cfg setting that re-keys every row,
 * not something to flip live.
 */
const rememberedUntilRestart = (
  choose: () => FrameworkAdapter | null
): (() => FrameworkAdapter | null) => heldUntilRestart(CORE_RESOURCES, choose, () => true);

/**
 * The adapter answering for this server, or `null` when nothing is.
 *
 * `detectFramework` is this, named. Expressing both through one function is what makes the
 * promise the old code made in prose — "one detection rather than two that can disagree" —
 * structural: there is no second place for the framework to be decided.
 *
 * Remembered: see `rememberedUntilRestart`.
 */
const activeAdapter = rememberedUntilRestart((): FrameworkAdapter | null => {
  const framework = runningFramework();

  if (!standaloneAdapter.detect()) return framework;

  // The convar set alongside a live framework is a misconfiguration rather than a
  // preference, and the framework wins — see `reportStandaloneConflict` for why that
  // direction and not the other.
  if (framework) {
    reportStandaloneConflict(framework.kind as 'qb' | 'esx');
    return framework;
  }

  return standaloneAdapter;
});

/**
 * Which framework is answering for this server **right now** — and the third answer.
 *
 * `usesEsx()` below is a boolean and cannot say "I do not know yet", which is fine for every
 * question it was written for: it decides which of two lookups renders a name, and being
 * wrong renders no name. It is **not** fine for a question whose wrong answer deletes rows.
 *
 * The third state is real, not theoretical. `exposes` swallows the throw a FiveM `exports`
 * proxy raises for a resource that is not running, so "es_extended has not started yet" and
 * "this is a qb server" are the same answer to a boolean. FiveM starts resources in
 * `server.cfg` order and nothing in this repo controls it: `ensure mica` above
 * `ensure es_extended` is a legal config, and micaOS's own `onResourceStart` fires inside
 * that window. A sweep that resolved `unknown` to qb on such a server would compare ESX
 * identifiers against a `players` table — and if that box carries a leftover, non-empty
 * `players` from a previous qb install, every micaOS row looks unowned and the whole phone
 * database is deleted at boot with a log line saying it worked.
 *
 * So: `unknown` is a first-class answer, and a caller that cannot act safely without knowing
 * must **skip**. It must never be folded back into a default.
 *
 * A qb core still wins when both are installed, matching `getPlayer`: a live server does not
 * change which string it calls a citizenid on the strength of a second resource being
 * present.
 *
 * **`standalone` is the fourth answer, and it is only ever reached by an operator asking for
 * it** — `mica_standalone`, read by `standaloneRequested`. It is deliberately *not* what
 * `unknown` resolves to when nothing answers, for the reason the paragraph above gives: the
 * probe cannot tell a missing framework from one that has not started yet, so inferring
 * standalone from silence would re-key a real server's rows during its own boot window.
 *
 * The convar set alongside a live framework is a misconfiguration rather than a preference,
 * and the framework wins — see `reportStandaloneConflict` for why that direction and not the
 * other. `unknown` is unchanged in every other respect: with the convar unset and no
 * framework, this still answers `unknown`, and `usesEsx`'s truth table is untouched.
 */
export const detectFramework = (): FrameworkKind => activeAdapter()?.kind ?? 'unknown';

/**
 * Which schema the citizenid columns were sized for (MICA-289): `players(citizenid)` on qb,
 * none on ESX or standalone, not yet known during the boot window. Installed at import so
 * `Repository`'s write guard and the `micaschema` planner read it without importing this
 * file — see `ownerWidth.ts`.
 */
setOwnerTableResolver(() => {
  const kind = detectFramework();
  return kind === 'unknown' ? null : kind === 'qb';
});

/**
 * The adapter an **offline read** should use.
 *
 * `unknown` falls through to qb, which is what the branch chain this replaces did: with no
 * framework detected it ran the `players` query, and doing so on a box that has no such
 * table is harmless — `offlineLookup` degrades it to "no name" and says so once. Only the
 * *destructive* caller distinguishes the third state, and that one asks `ownerTable`.
 */
const offlineAdapter = (): FrameworkAdapter => activeAdapter() ?? qbAdapter;

/**
 * The adapter that can serve one particular call, or `null`.
 *
 * **Selection is per method, not per server, and that is what the code this replaces did.**
 * `getPlayer` probed `qbx_core.GetPlayer`, `getAllPlayers` probed `qbx_core.GetQBPlayers`, and
 * `registerUsableItem` probed `qbx_core.CreateUseableItem` — three different exports, each
 * asked for immediately before it was called. A FiveM resource exposes each of its exports
 * independently, so a build offering one and not another has to keep falling through to the
 * next core exactly as it always has; `FrameworkBridge.test.ts` pins that with a qbx fake that
 * exposes only `GetQBPlayers`.
 *
 * Standalone is asked last **and only when it is genuinely the verdict**. `standaloneAdapter`
 * would otherwise claim every call the moment the convar is set, including on a server with a
 * framework running — which is the misconfiguration `reportStandaloneConflict` refuses. This
 * is the `detectFramework() === 'standalone'` guard that stood at the end of each old chain,
 * written once.
 */
const serving = (can: (adapter: FrameworkAdapter) => boolean): FrameworkAdapter | null => {
  for (const adapter of FRAMEWORK_ADAPTERS) {
    if (can(adapter)) return adapter;
  }
  return detectFramework() === 'standalone' && can(standaloneAdapter) ? standaloneAdapter : null;
};

/**
 * `serving`'s answer for the two calls every request makes, remembered (MICA-352).
 *
 * Per method still, for the reason `serving` gives. `registerUsableItem` is not remembered:
 * its predicate *is* the registration, so walking the adapters is the act, not a probe.
 */
const servingGetPlayer = rememberedUntilRestart(() => serving((adapter) => adapter.canGetPlayer()));
const servingListPlayers = rememberedUntilRestart(() =>
  serving((adapter) => adapter.canListPlayers())
);

/**
 * **There is deliberately no "join the framework's character table" helper here**, and the
 * reason is worth keeping (MICA-197).
 *
 * The obvious way to put a name beside a row is a `LEFT JOIN` onto `ownerTable()`. It was
 * written that way first, and a throwaway MariaDB 11.8 loaded with `mica.esx.sql` plus a
 * stock es_extended `users` refused it outright: MySQL errno 1267, *Illegal mix of
 * collations*. `schemaSql.TABLE_COLLATION` pins every micaOS column to `utf8mb4_unicode_ci`
 * while `users.identifier` takes the server default, which from MariaDB 11.4 is
 * `utf8mb4_uca1400_ai_ci` — and a **column-to-column** comparison, unlike one against a bound
 * parameter, has no coercible side to settle on.
 *
 * Nothing requires the two collations to agree any more: MICA-157's check that they did
 * existed for qb's foreign keys onto `players`, and MICA-300 removed both the keys and the
 * check. A join would have quietly reintroduced the requirement, on every framework, with
 * nothing to verify it.
 *
 * `COLLATE` in the join condition makes the statement legal and stops the index on
 * `users.identifier` being usable, which trades a correctness bug for a full scan of the
 * framework's character table on every read. So the lookups here compare against **bound
 * parameters** instead — `findOfflineByCitizenIds` below — which are collation-coercible and
 * index-friendly, and `PlayerDirectory` is the one place a name comes from.
 */

/* ──────────────────────────────────────────────────────────────────────────────
 * Who is online, without asking the framework every time (MICA-197)
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Loaded characters, both ways round.
 *
 * `getSourceByCitizenId` used to walk `getAllPlayers()` on every call, and
 * `getAllPlayers()` is not a cheap read: on qb it marshals every connected player's whole
 * table across the Lua boundary, and on ESX it does the same through `GetExtendedPlayers`.
 * `Messages.deliverToParticipants` called it once per participant, so a group send was one
 * full walk per recipient — for a 32-person thread, 32 snapshots of the entire server to
 * answer 32 questions one snapshot already contains.
 *
 * Two maps rather than one, because both directions are needed and neither can be derived
 * from the other in constant time: the citizenid map answers the lookup, and the source map
 * is what lets `rememberSource` evict a **recycled server id** before it can be believed.
 *
 * FiveM reassigns server ids, which is the hazard `rateLimit.forgetSource` and
 * `shell.refusalsLogged` already clear on `playerDropped` for — and the stake here is higher
 * than theirs. A stale entry there hands somebody else's rate budget to a new player; a stale
 * entry *here* would `emitNet` one player's message to whoever inherited their id. So this
 * is defended three times over rather than once: `playerDropped` removes the entry
 * (`lib/shell.ts` wires it), `rememberSource` evicts by source before recording, so a
 * recycled id cannot keep its previous owner even if that event were ever missed, and a
 * reseed rebuilds the whole thing from the framework.
 *
 * A multichar logout keeps the connection and fires no `playerDropped`, so the framework's
 * unload event removes the entry as well (`logOutSource`, MICA-382).
 */
const sourceByCitizen = new Map<string, number>();
const citizenBySource = new Map<number, string>();

/**
 * The character each source logged out of, while the player sits on character select
 * (MICA-382). A reseed skips exactly that pairing.
 *
 * Forgetting the entry is not enough on its own, because the frameworks still list the
 * character for a while after announcing the logout: qbx_core fires
 * `QBCore:Server:OnPlayerUnload`, `Wait(200)`, and only then clears the player, and ESX clears
 * `ESX.Players[id]` in the callback of the save it starts on `esx:playerLogout`. (qb-core
 * clears the player straight after firing the event, so has no window.) A miss in
 * that window walks `getAllPlayers` and would put the character straight back, addressing
 * their pushes to the character-select screen again until the next load.
 *
 * The citizenid is kept, not just the source, so a reseed still finds a *different*
 * character seated on the source before micaOS hears it load. Cleared by `rememberSource`
 * (a load was announced on the source, whoever it names) and by `forgetSource` (a drop),
 * so it never holds more than the connected players.
 */
const loggedOutOf = new Map<number, string>();

/**
 * **The registry never answers a miss.** It is a fast path over the walk, not a replacement
 * for it: a citizenid it has no entry for causes exactly one `getAllPlayers()` snapshot, and
 * whatever is still absent after that really is offline.
 *
 * That is the whole of the freshness argument, and it is deliberately the boring one. A
 * registry that reported "offline" on its own would need to be complete, and it structurally
 * cannot be: `onPlayerLoaded` is the only thing that fills it, and no character loads again
 * after a **resource restart with players already connected**. A phone that silently stopped
 * delivering to everyone who was online at the restart is a far worse bug than a walk.
 *
 * So the guarantee is bounded rather than absolute, and it is the one the callers needed:
 * **one walk per call instead of one per citizenid.** `deliverToParticipants` asked about a
 * 32-person thread one participant at a time and paid 32 snapshots of the whole server; it
 * now pays one when anybody in it is offline and none when everybody is loaded.
 *
 * **And at most one walk per `RESEED_INTERVAL_MS`** (MICA-353). A miss is any offline citizen,
 * so "one walk per call" was still one per text into a thread with an offline member, one per
 * push to an offline citizen — on qb a whole-server snapshot per request. A miss only
 * withholds a live push; the row is written either way, and the recipient reads it when they
 * load. Misdelivery comes from a stale *hit*, which this does not touch: `rememberSource`
 * evicts by source and `playerDropped` forgets.
 *
 * The window is skipped whenever the registry has reason to be incomplete, through
 * `reseedDirty`: at start (a restart with players connected loads nobody), when a core starts
 * or stops, when `rememberSource` could not record a player it was told had loaded, and after
 * a walk that found nobody — which is either an empty server, where a walk costs nothing, or
 * a framework that failed to answer, where the old behaviour of asking again is right. So a
 * player who loads is found at once through `rememberSource`, or, when that failed, on the
 * next miss; one whose load micaOS never heard of at all is found within the window.
 */

/** How long one walk's answer stands before a miss may walk again (MICA-353). */
export const RESEED_INTERVAL_MS = 5000;

/** When the last walk ran, by `Date.now()`. */
let lastReseedAt = Number.NEGATIVE_INFINITY;

/** Whether the next miss walks regardless of the window. True at start: nothing is recorded. */
let reseedDirty = true;

/**
 * A core starting or stopping loads or unloads every character on it; so does the test seam.
 * Whoever was on character select is either listed by the core that comes back or is not, so
 * a recorded logout has nothing left to correct (MICA-382).
 */
dropOn(CORE_RESOURCES, [], () => {
  reseedDirty = true;
  loggedOutOf.clear();
});

const reseedDue = (): boolean => reseedDirty || Date.now() - lastReseedAt >= RESEED_INTERVAL_MS;

/* ──────────────────────────────────────────────────────────────────────────────
 * The integration door's synthetic players (MICA-397)
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * The highest source a synthetic player can have. The door counts down from here. FiveM's
 * server ids are positive, and `-1` is `emitNet`'s broadcast target, so no connected player and
 * no broadcast is ever at or below it.
 *
 * **The other negative sources in the tree must never reach it.** `services/Phone.ts` counts a
 * line call's far end down from `-2`, one per call and with no floor, and `getCitizenId` on that
 * pseudo-source must keep answering null. A bound at `-1000` was reached after 998 line calls in
 * one process. At a million it is out of reach in practice, and the door's harness is the only
 * server that installs synthetic players at all.
 */
export const SYNTHETIC_SOURCE_MAX = -1_000_000;

/** What the door hands the bridge: its own players, by synthetic source and by citizenid. */
export interface SyntheticPlayers {
  /** The synthetic player on `src`, or null. Asked only for `src <= SYNTHETIC_SOURCE_MAX`. */
  player(src: number): FrameworkPlayer | null;
  /** The synthetic source of a citizen the door seeded, or null. Asked only on a registry miss. */
  sourceOf(citizenid: string): number | null;
  /**
   * Whether the synthetic player on `src` was seeded as an admin (MICA-386's in-server proof).
   * Asked only for `src <= SYNTHETIC_SOURCE_MAX`, through `FrameworkBridge.isSyntheticAdmin`.
   */
  isAdmin(src: number): boolean;
}

/**
 * Read once, at module load — resource start — exactly as `lib/integrationDoor.ts` reads it, so
 * nothing can install synthetic players on a server that did not start with the door open.
 */
const integrationAtStart = GetConvar('mica_integration', '') === '1';

let synthetic: SyntheticPlayers | null = null;

/**
 * Let the integration door's players answer `getPlayer` and `getSourcesByCitizenId`, so a
 * handler that asks the bridge who a source is again after an await, as Messages' and
 * PhoneNumbers' MICA-336 guards do, gets an answer for a synthetic player too. Without this
 * those services could never be driven through the door.
 *
 * Two limits make this safe, and each holds on every call. `getPlayer` asks the resolver only
 * for a source at or below `SYNTHETIC_SOURCE_MAX`, so a connected player's positive source is
 * never answered by it. `getSourcesByCitizenId` asks it only for a citizenid that the registry,
 * and the walk behind it, did not find, so a connected character always answers with their real
 * source. Throws when `mica_integration` was not `1` at start, and on a second install, so there
 * is one resolver per process and only on a harness server.
 */
export const installSyntheticPlayers = (players: SyntheticPlayers): void => {
  if (!integrationAtStart) {
    throw new Error(
      '[FrameworkBridge] synthetic players can be installed only when mica_integration was 1 ' +
        'at resource start.'
    );
  }
  if (synthetic) {
    throw new Error('[FrameworkBridge] synthetic players are already installed.');
  }
  synthetic = players;
};

/** The synthetic player on `src`, or null; never asked for a source above the bound. */
const syntheticPlayer = (src: number): FrameworkPlayer | null => {
  if (!synthetic || !(src <= SYNTHETIC_SOURCE_MAX)) return null;
  const player = synthetic.player(src);
  return player && player.source === src ? player : null;
};

/** The synthetic source of `citizenid`, or null; never a source above the bound. */
const syntheticSourceOf = (citizenid: string): number | null => {
  if (!synthetic) return null;
  const src = synthetic.sourceOf(citizenid);
  return typeof src === 'number' && src <= SYNTHETIC_SOURCE_MAX ? src : null;
};

/** Whether the synthetic player on `src` holds the door's admin flag; see `isSyntheticAdmin`. */
const syntheticAdmin = (src: number): boolean =>
  syntheticPlayer(src) !== null && synthetic?.isAdmin(src) === true;

export class FrameworkBridge {
  /**
   * Where this server keeps the characters micaOS's rows belong to — or `null`.
   *
   * Behind the bridge for the same reason `findOfflineByCitizenId` is: it is a framework
   * question, not a phone one. The difference is that this answers it for *any* micaOS
   * table rather than for one lookup, which is what lets a single sweep clean up after a
   * deleted character on either framework (MICA-152).
   *
   * **`null` when the framework is not known yet, and a caller must skip on it.** See
   * `detectFramework` for why that state exists and what folding it into a default costs.
   * Resolving the table from the *framework* rather than from probing which table happens
   * to exist is the whole point: a box with both `players` and `users` present is the
   * dangerous case, and a probe picks the wrong one there by construction.
   *
   * This says where to look. It does **not** say whether looking will work: the table may
   * be absent, unreadable, or empty. Every caller has to treat all three as "I do not
   * know", never as "there are no characters" — see `orphanSweep.ts`.
   */
  public static ownerTable(): OwnerTable | null {
    return activeAdapter()?.ownerTable() ?? null;
  }

  /**
   * What this server can answer about jobs, for the start-up log (MICA-227).
   *
   * The active adapter's answer, resolved the way `ownerTable` is, so the two cannot name
   * different frameworks. The fallback is the same third state `detectFramework` keeps as
   * `unknown`: asked inside the boot window before the core has started, this says so
   * rather than reporting the absence of jobs as a fact about the server.
   */
  public static jobSupport(): JobSupport {
    return activeAdapter()?.jobSupport() ?? NO_JOB_SUPPORT;
  }

  /**
   * The framework's record of a player who may be offline, by citizenid.
   *
   * Behind the bridge rather than in `PlayerDirectory` because it is a framework question:
   * qb keeps players in `players(citizenid)` with a `charinfo` JSON column, ESX keeps them
   * in `users(identifier)` with `firstname`/`lastname` columns, standalone keeps only the
   * number micaOS itself issued, and every other framework will keep them somewhere else
   * again. `PlayerDirectory` asks who somebody is; the adapter knows where to look.
   */
  public static async findOfflineByCitizenId(citizenid: string): Promise<FrameworkIdentity | null> {
    if (!citizenid) return null;
    return await offlineAdapter().findOfflineByCitizenId(citizenid);
  }

  /**
   * The same, for many citizenids, in **one** query (MICA-197).
   *
   * `findOfflineByCitizenId` is a `LIMIT 1` read, so anything rendering a list of people —
   * a conversation's participants, a leaderboard's ten rows — paid one round trip per name.
   *
   * Returned as a map rather than an array so a caller can ask about somebody the framework
   * has no record of and get the same "not found" a single lookup gives, rather than having
   * to match rows back up by position.
   *
   * **Bound parameters, never a join.** Putting the name beside a row with a `LEFT JOIN`
   * onto the character table looks obviously right and is not: micaOS pins every column to
   * `utf8mb4_unicode_ci` and es_extended's `users.identifier` takes the server default,
   * which from MariaDB 11.4 is `utf8mb4_uca1400_ai_ci`. A column-to-column comparison
   * across two collations is MySQL errno 1267 — verified against a throwaway MariaDB 11.8
   * loaded with `mica.esx.sql` — where a comparison against a parameter has a coercible
   * side and settles. The one column-to-column comparison micaOS does make, the orphan
   * sweep's, collates micaOS's side into the owner's (MICA-299); nothing else joins to the
   * character table, and this is what keeps that true.
   */
  public static async findOfflineByCitizenIds(
    citizenids: readonly string[]
  ): Promise<Map<string, FrameworkIdentity>> {
    const wanted = [...new Set(citizenids.filter(Boolean))];
    if (wanted.length === 0) return new Map();
    return await offlineAdapter().findOfflineByCitizenIds(wanted);
  }

  /**
   * The same, by phone number.
   *
   * ESX answers nothing here and says so by answering nothing: core `users` has no phone
   * column, so there is nothing to match on, and guessing at another resource's table would
   * be right for one server population and silently wrong for the rest. Standalone answers
   * it best of all, because micaOS issued the number itself.
   */
  public static async findOfflineByPhone(phone: string): Promise<FrameworkIdentity | null> {
    if (!phone) return null;
    return await offlineAdapter().findOfflineByPhone(phone);
  }

  public static getPlayer(src: number): FrameworkPlayer | null {
    try {
      // The door's players, on their own sources only; see `installSyntheticPlayers`.
      if (synthetic && src <= SYNTHETIC_SOURCE_MAX) return syntheticPlayer(src);
      return servingGetPlayer()?.getPlayer(src) ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting player:', traceOf(error));
    }
    return null;
  }

  /**
   * Whether `src` is a synthetic player the integration door seeded as an admin, which is how
   * the in-server suite reaches the admin-gated report actions (`services/Admin.ts`'s
   * `isAdmin`). False for every source above `SYNTHETIC_SOURCE_MAX`, so never for a connected
   * player, a broadcast or a line call; false on a server that did not start with
   * `mica_integration` at `1`, where nothing can be installed; and false for a synthetic source
   * the door holds no player on, or one seeded without the flag. Never throws.
   */
  public static isSyntheticAdmin(src: number): boolean {
    try {
      return syntheticAdmin(src);
    } catch (error) {
      console.error('[FrameworkBridge] Error resolving a synthetic admin:', traceOf(error));
    }
    return false;
  }

  public static getCitizenId(src: number): string | null {
    const player = FrameworkBridge.getPlayer(src);
    return player ? player.citizenid : null;
  }

  public static getPlayerPhone(src: number): string | null {
    const player = FrameworkBridge.getPlayer(src);
    return player?.phone || null;
  }

  /**
   * Every connected player, keyed by source, in the qb shape.
   *
   * ESX and standalone records are normalised into that shape by their own adapters, so the
   * five callers of this outside `server/lib/framework/` — `proximity.ts`, `appEvents.ts`,
   * `Signal.ts`, `Mail.ts` and `Music.ts` — need no framework check of their own.
   */
  public static getAllPlayers(): Record<string | number, any> {
    try {
      return servingListPlayers()?.getAllPlayers() ?? {};
    } catch (error) {
      console.error('[FrameworkBridge] Error fetching all players:', traceOf(error));
    }
    return {};
  }

  /**
   * Record that a character has loaded on this server id.
   *
   * Wired from `lib/shell.ts`'s `onPlayerLoaded` registry rather than from a listener of its
   * own, so this module keeps having no framework event of its own to get wrong, and so the
   * source it is handed has already been established by the resolution MICA-136 installed.
   *
   * **Evicts the id first.** If `playerDropped` were ever missed for whoever previously held
   * this server id, their entry would still be here, and FiveM reassigns ids — so the next
   * message addressed to them would go to this player instead. Evicting by source closes that
   * window to the interval between a connection and its character load, during which the
   * previous holder's phone is not being served either.
   */
  public static rememberSource(src: number): void {
    if (!Number.isInteger(src) || src <= 0) return;

    // A load on the source ends any logout recorded on it, whether or not it can be named.
    // Including a forged one: inside qbx's `Wait(200)` the player's own client can send
    // `QBCore:Server:OnPlayerLoaded`, which still names the character who left and so records
    // them here again. Accepted: the pushes it brings back are only that player's own.
    loggedOutOf.delete(src);

    const player = FrameworkBridge.getPlayer(src);
    // `getPlayer` has already said why, through `unidentified`. A player the framework will
    // not name must not be recorded under a name: that is the whole of MICA-133's rule. They
    // may yet be named, so the next miss walks rather than waiting out the window (MICA-353).
    if (!player?.citizenid) {
      reseedDirty = true;
      return;
    }

    FrameworkBridge.forgetSource(src);

    // The same character reconnecting on a different id: drop the id they used to be on, so
    // `citizenBySource` never outlives the mapping `sourceByCitizen` agrees with.
    const previous = sourceByCitizen.get(player.citizenid);
    if (previous !== undefined) citizenBySource.delete(previous);

    sourceByCitizen.set(player.citizenid, src);
    citizenBySource.set(src, player.citizenid);
  }

  /** Forget a server id. Wired from `lib/shell.ts`'s `playerDropped` handler. */
  public static forgetSource(src: number): void {
    loggedOutOf.delete(src);
    const citizenid = citizenBySource.get(src);
    if (citizenid === undefined) return;
    citizenBySource.delete(src);
    // Guarded, because the character may already have been recorded on a newer id.
    if (sourceByCitizen.get(citizenid) === src) sourceByCitizen.delete(citizenid);
  }

  /**
   * Forget a server id whose character logged out while the connection stayed (MICA-382).
   * Wired from `lib/shell.ts`'s framework unload listeners.
   *
   * A multichar logout to character select fires no `playerDropped`, so without this the
   * registry kept answering the character who left with this source until another character
   * loaded on it, and a push meant for them — a 911 call, a contact share, a notification —
   * landed on the select screen.
   *
   * **Does not mark the registry dirty.** Nothing is missing from it: the character really is
   * offline, and the next miss walks on the window as it always does. And the walk cannot put
   * them back, because `loggedOutOf` records the pairing a reseed must skip. The citizenid is
   * taken from the registry, or from the framework when the registry never heard them load
   * (a resource restart since): the frameworks still name the character when they announce
   * the logout.
   */
  public static logOutSource(src: number): void {
    if (!Number.isInteger(src) || src <= 0) return;
    const citizenid = citizenBySource.get(src) ?? FrameworkBridge.getPlayer(src)?.citizenid;
    FrameworkBridge.forgetSource(src);
    if (citizenid) loggedOutOf.set(src, citizenid);
  }

  /**
   * Rebuild the registry from the framework. The one walk, and the only one anything here does.
   *
   * Wholesale rather than additive: a rebuild is also what corrects an entry `playerDropped`
   * never arrived for, and merging would keep exactly the stale rows this exists to drop.
   */
  private static reseedSources(): void {
    const players = FrameworkBridge.getAllPlayers();

    sourceByCitizen.clear();
    citizenBySource.clear();

    for (const key in players) {
      const src = parseInt(key, 10);
      const citizenid = players[key]?.PlayerData?.citizenid;
      if (!citizenid || !Number.isFinite(src)) continue;
      // Still listed in the moments after a logout; see `loggedOutOf` (MICA-382).
      if (loggedOutOf.get(src) === citizenid) continue;
      sourceByCitizen.set(citizenid, src);
      citizenBySource.set(src, citizenid);
    }

    lastReseedAt = Date.now();
    // Nobody found: an empty server, where walking again costs nothing, or a framework that
    // failed to answer, where walking again is what the next miss did before MICA-353.
    reseedDirty = sourceByCitizen.size === 0;
  }

  /**
   * The server ids of every loaded character, from the registry: no player records (MICA-354).
   *
   * For the loops that run on a timer and want ids — `Signal`'s poll every 2s, the
   * speakerphone's every second, `Music`'s while a stereo plays — and for the walks that only
   * need a record for the few players they end up keeping (`proximity`, `jobLines`). Each of
   * them read `Object.keys(getAllPlayers())`, which on qb is a msgpack copy of every
   * connected player's whole record, to throw everything but the keys away.
   *
   * Walks first only when `reseedDirty` says the registry has reason to be incomplete — at
   * start, after a core starts or stops, after `rememberSource` could not name a player, after
   * a walk that found nobody — so a restart with players connected is filled before the first
   * tick answers. Otherwise the registry is kept by `rememberSource` and `forgetSource`.
   *
   * **An id here is not a loaded character's proof.** A multichar switch keeps the source and
   * fires no drop; the framework's unload event forgets it (`logOutSource`, MICA-382), but a
   * framework or multichar that never fires one leaves the registry holding a player sitting
   * on character select, under the character they left. A caller that acts on
   * *who* the player is, or that must only reach a loaded character, asks `getPlayer` for the
   * ids it keeps, as `proximity`, `speakerphone` and `jobLines` do. A copy, so a caller may
   * forget a source while it walks.
   */
  public static onlineSources(): number[] {
    try {
      if (reseedDirty) FrameworkBridge.reseedSources();
    } catch (error) {
      console.error('[FrameworkBridge] Error resolving sources:', traceOf(error));
    }
    return [...citizenBySource.keys()];
  }

  /**
   * The server id of an online character, or null when they are not connected.
   *
   * Needed to push anything to a specific character — delivering a message, for one.
   * Everything else here goes the other way, from a source to their data.
   */
  public static getSourceByCitizenId(citizenid: string): number | null {
    return FrameworkBridge.getSourcesByCitizenId([citizenid]).get(citizenid) ?? null;
  }

  /**
   * Server ids for many citizenids, from the registry above and — only if it cannot answer
   * all of them — one walk.
   *
   * This used to take a `getAllPlayers()` snapshot per call, and `getSourceByCitizenId` was a
   * one-element call into it, so `Messages.deliverToParticipants` walked the whole server once
   * per recipient. The bound is now **one walk per call**: everyone the registry knows is
   * answered outright, and a single reseed settles the rest. See the note above the registry
   * for why a miss is never simply believed — and for the window that bounds the walks across
   * calls, after which a miss is believed for at most `RESEED_INTERVAL_MS` (MICA-353).
   */
  public static getSourcesByCitizenId(citizenids: readonly string[]): Map<string, number> {
    const found = new Map<string, number>();
    if (citizenids.length === 0) return found;

    const wanted = new Set(citizenids.filter(Boolean));
    if (wanted.size === 0) return found;

    /** Fills `found` from the registry and reports whether anything was left unanswered. */
    const collect = (): boolean => {
      found.clear();
      let missing = false;
      for (const citizenid of wanted) {
        const src = sourceByCitizen.get(citizenid);
        if (src === undefined) missing = true;
        else found.set(citizenid, src);
      }
      return missing;
    };

    try {
      if (collect() && reseedDue()) {
        FrameworkBridge.reseedSources();
        collect();
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error resolving sources:', traceOf(error));
    }

    // The door's players, only for citizenids the registry and its walk did not find.
    if (synthetic && found.size < wanted.size) {
      try {
        for (const citizenid of wanted) {
          if (found.has(citizenid)) continue;
          const src = syntheticSourceOf(citizenid);
          if (src !== null) found.set(citizenid, src);
        }
      } catch (error) {
        console.error('[FrameworkBridge] Error resolving synthetic sources:', traceOf(error));
      }
    }
    return found;
  }

  /**
   * The connected player on this number, or null.
   *
   * **micaOS's own record first** (MICA-284). A number belongs to a phone, and the cache in
   * `lib/phoneNumbers.ts` knows who last used the phone it is on. The walk over every
   * connected player's `charinfo.phone` below is the fallback for a number micaOS has not
   * resolved this process — ESX, or a character who has not synced since the restart — and it
   * cannot be the first answer on qb: `charinfo.phone` is a mirror micaOS writes back on a
   * switch and deliberately leaves alone for a player whose phone was taken, so the walk would
   * find the victim beside the thief and answer with whichever came first.
   *
   * When the record names a holder who is not connected, the answer is null rather than the
   * walk: the number is theirs, and finding somebody else still carrying it in `charinfo`
   * would ring the wrong phone.
   */
  public static getPlayerByPhone(phone: string): FrameworkPlayer | null {
    const holder = citizenIdForNumber(phone);
    if (holder) {
      const src = FrameworkBridge.getSourceByCitizenId(holder);
      if (src === null) return null;
      const player = FrameworkBridge.getPlayer(src);
      return player?.citizenid === holder ? player : null;
    }

    try {
      const players = FrameworkBridge.getAllPlayers();
      for (const src in players) {
        const targetPlayer = players[src];
        if (targetPlayer?.PlayerData?.charinfo?.phone === phone) {
          return FrameworkBridge.getPlayer(parseInt(src, 10));
        }
      }
    } catch (error) {
      console.error(
        `[FrameworkBridge] Error finding player by phone ${who(phone)}:`,
        traceOf(error)
      );
    }
    return null;
  }

  /**
   * Consume an item through whatever inventory this server has.
   *
   * The body moved to `framework/runtime.ts`, because three adapters call it and an adapter
   * reaching back into the class that selects it would close a runtime cycle. The static
   * stays here: it is part of the public surface, and `client/lib/FrameworkBridge.ts` has a
   * twin of it.
   */
  public static removeInventoryItem(
    src: number,
    player: any,
    item: string,
    count: number
  ): boolean {
    return removeItemThroughInventory(src, player, item, count);
  }

  /**
   * How many of an item a loaded player holds, or `null` when no inventory here can say
   * (MICA-229). `lib/deviceItem.ts` is the caller; `countInventoryItem` has the order it
   * asks in and why `null` is not `0`.
   */
  public static countItem(player: FrameworkPlayer, item: string): number | null {
    return countItemThroughInventory(player.source, player.rawPlayer, item);
  }

  /**
   * Every slot holding an item, with what that copy carries, or `null` when this inventory
   * cannot carry metadata at all (MICA-279).
   *
   * `null` is not "none held" — `framework/itemMetadata.ts` has which inventories can answer
   * and why the distinction is the whole point.
   */
  public static itemSlots(player: FrameworkPlayer, item: string): ItemSlot[] | null {
    return readItemSlots(player.source, player.rawPlayer, item);
  }

  /**
   * Merge a patch into one slot's metadata, answering whether it was really stored.
   *
   * Merged rather than replaced, because ox_inventory's `SetMetadata` assigns the whole
   * table. A `false` here means the value is not on the item, so a caller must not act as
   * though it is.
   */
  public static setItemMetadata(
    player: FrameworkPlayer,
    item: string,
    slot: number,
    patch: Record<string, unknown>
  ): boolean {
    return writeItemMetadata(player.source, player.rawPlayer, item, slot, patch);
  }

  /**
   * Register a usable item with whatever framework is here — which may be nothing.
   *
   * Each adapter answers whether it actually registered. The frameworkless case is
   * `standaloneAdapter`'s, and it is the one that turns "nothing to register with" into a
   * line saying what the operator loses rather than returning quietly, which reads exactly
   * like a registration that worked.
   */
  public static registerUsableItem(
    item: string,
    // qbx_core annotates its own callback as `fun(source, item)` and ox_inventory fills
    // that second argument with the slot data, which is how MICA-280 knows *which* phone
    // was used. Typed loosely because the shape belongs to another resource.
    cb: (source: number, used?: { slot?: unknown }) => void
  ): void {
    try {
      // The predicate registers: `serving` walks the adapters in order and stops at the
      // first that says it handled it, which is the chain the old else-if ladder was.
      serving((adapter) => adapter.registerUsableItem(item, cb));
    } catch (error) {
      console.error(
        `[FrameworkBridge] Framework item registration skipped for '${item}':`,
        traceOf(error)
      );
    }
  }
}
