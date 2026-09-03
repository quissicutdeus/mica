// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdFromIdentifier, CITIZENID_MAX_LENGTH } from '@gphone/shared/framework';
import { esxAdapter } from './framework/esx';
import { qbAdapter } from './framework/qb';
import { qbxAdapter } from './framework/qbx';
import { reportStandaloneConflict, standaloneAdapter } from './framework/standalone';
import {
  countInventoryItem as countItemThroughInventory,
  removeInventoryItem as removeItemThroughInventory,
  type FrameworkAdapter,
  type FrameworkIdentity,
  type FrameworkKind,
  type FrameworkPlayer,
  type OwnerTable
} from './framework/runtime';

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
export type { FrameworkAdapter, FrameworkIdentity, FrameworkKind, FrameworkPlayer, OwnerTable };
export { __setResourceLookup, __resetOfflineLookupWarnings } from './framework/runtime';
export { __resetEsxMetaWarning } from './framework/esx';
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
 * The adapter answering for this server, or `null` when nothing is.
 *
 * `detectFramework` is this, named. Expressing both through one function is what makes the
 * promise the old code made in prose — "one detection rather than two that can disagree" —
 * structural: there is no second place for the framework to be decided.
 */
const activeAdapter = (): FrameworkAdapter | null => {
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
};

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
 * `server.cfg` order and nothing in this repo controls it: `ensure gphone` above
 * `ensure es_extended` is a legal config, and gPhone's own `onResourceStart` fires inside
 * that window. A sweep that resolved `unknown` to qb on such a server would compare ESX
 * identifiers against a `players` table — and if that box carries a leftover, non-empty
 * `players` from a previous qb install, every gPhone row looks unowned and the whole phone
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
 * it** — `gphone_standalone`, read by `standaloneRequested`. It is deliberately *not* what
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
 * **There is deliberately no "join the framework's character table" helper here**, and the
 * reason is worth keeping (MICA-197).
 *
 * The obvious way to put a name beside a row is a `LEFT JOIN` onto `ownerTable()`. It was
 * written that way first, and a throwaway MariaDB 11.8 loaded with `gphone.esx.sql` plus a
 * stock es_extended `users` refused it outright: MySQL errno 1267, *Illegal mix of
 * collations*. `schemaSql.TABLE_COLLATION` pins every gPhone column to `utf8mb4_unicode_ci`
 * while `users.identifier` takes the server default, which from MariaDB 11.4 is
 * `utf8mb4_uca1400_ai_ci` — and a **column-to-column** comparison, unlike one against a bound
 * parameter, has no coercible side to settle on.
 *
 * That is exactly the hazard `collationCheck.ts` was written for in MICA-157, and its
 * reasoning explicitly exempts ESX: no `players` table, no foreign key, nothing to check. A
 * join would have quietly reintroduced the requirement on the one install path nothing
 * verifies it on.
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
 */
const sourceByCitizen = new Map<string, number>();
const citizenBySource = new Map<number, string>();

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
 */

export class FrameworkBridge {
  /**
   * Where this server keeps the characters gPhone's rows belong to — or `null`.
   *
   * Behind the bridge for the same reason `findOfflineByCitizenId` is: it is a framework
   * question, not a phone one. The difference is that this answers it for *any* gPhone
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
   * The framework's record of a player who may be offline, by citizenid.
   *
   * Behind the bridge rather than in `PlayerDirectory` because it is a framework question:
   * qb keeps players in `players(citizenid)` with a `charinfo` JSON column, ESX keeps them
   * in `users(identifier)` with `firstname`/`lastname` columns, standalone keeps only the
   * number gPhone itself issued, and every other framework will keep them somewhere else
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
   * onto the character table looks obviously right and is not: gPhone pins every column to
   * `utf8mb4_unicode_ci` and es_extended's `users.identifier` takes the server default,
   * which from MariaDB 11.4 is `utf8mb4_uca1400_ai_ci`. A column-to-column comparison
   * across two collations is MySQL errno 1267 — verified against a throwaway MariaDB 11.8
   * loaded with `gphone.esx.sql` — where a comparison against a parameter has a coercible
   * side and settles. `collationCheck.ts` (MICA-157) exists for that hazard and
   * explicitly exempts ESX on the grounds that nothing there joins to `users`. This is what
   * keeps that true.
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
   * it best of all, because gPhone issued the number itself.
   */
  public static async findOfflineByPhone(phone: string): Promise<FrameworkIdentity | null> {
    if (!phone) return null;
    return await offlineAdapter().findOfflineByPhone(phone);
  }

  public static getPlayer(src: number): FrameworkPlayer | null {
    try {
      return serving((adapter) => adapter.canGetPlayer())?.getPlayer(src) ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting player:', error);
    }
    return null;
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
      return serving((adapter) => adapter.canListPlayers())?.getAllPlayers() ?? {};
    } catch (error) {
      console.error('[FrameworkBridge] Error fetching all players:', error);
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

    const player = FrameworkBridge.getPlayer(src);
    // `getPlayer` has already said why, through `unidentified`. A player the framework will
    // not name must not be recorded under a name: that is the whole of MICA-133's rule.
    if (!player?.citizenid) return;

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
    const citizenid = citizenBySource.get(src);
    if (citizenid === undefined) return;
    citizenBySource.delete(src);
    // Guarded, because the character may already have been recorded on a newer id.
    if (sourceByCitizen.get(citizenid) === src) sourceByCitizen.delete(citizenid);
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
      sourceByCitizen.set(citizenid, src);
      citizenBySource.set(src, citizenid);
    }
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
   * for why a miss is never simply believed.
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
      if (collect()) {
        FrameworkBridge.reseedSources();
        collect();
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error resolving sources:', error);
    }
    return found;
  }

  public static getPlayerByPhone(phone: string): FrameworkPlayer | null {
    try {
      const players = FrameworkBridge.getAllPlayers();
      for (const src in players) {
        const targetPlayer = players[src];
        if (targetPlayer?.PlayerData?.charinfo?.phone === phone) {
          return FrameworkBridge.getPlayer(parseInt(src, 10));
        }
      }
    } catch (error) {
      console.error(`[FrameworkBridge] Error finding player by phone ${phone}:`, error);
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
   * (MICA-229). `lib/phoneItem.ts` is the caller; `countInventoryItem` has the order it
   * asks in and why `null` is not `0`.
   */
  public static countItem(player: FrameworkPlayer, item: string): number | null {
    return countItemThroughInventory(player.source, player.rawPlayer, item);
  }

  /**
   * Register a usable item with whatever framework is here — which may be nothing.
   *
   * Each adapter answers whether it actually registered. The frameworkless case is
   * `standaloneAdapter`'s, and it is the one that turns "nothing to register with" into a
   * line saying what the operator loses rather than returning quietly, which reads exactly
   * like a registration that worked.
   */
  public static registerUsableItem(item: string, cb: (source: number) => void): void {
    try {
      // The predicate registers: `serving` walks the adapters in order and stops at the
      // first that says it handled it, which is the chain the old else-if ladder was.
      serving((adapter) => adapter.registerUsableItem(item, cb));
    } catch (error) {
      console.error(`[FrameworkBridge] Framework item registration skipped for '${item}':`, error);
    }
  }
}
