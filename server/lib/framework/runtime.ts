// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The FiveM runtime seam, and the coercions every framework adapter needs (MICA-197).
 *
 * `FrameworkBridge.ts` was one file holding four frameworks — qbx_core, qb-core,
 * es_extended and none-at-all — interleaved, at eighteen hundred lines. Adding a fifth meant
 * reading all four to find where its branches would go. It is now one adapter per framework
 * under `server/lib/framework/`, and this module is what they share: how to reach another
 * resource, and how to judge what it answers with.
 *
 * Nothing here knows about any particular framework. Anything that does belongs in that
 * framework's own file, which is the property that makes the split worth having.
 */

export interface FrameworkPlayer {
  citizenid: string;
  source: number;
  phone?: string;
  /**
   * A balance, or `-Infinity` when the framework answered with something that is not one.
   *
   * The sentinel is deliberately unaffordable rather than `0`, so a caller comparing
   * `getMoney(...) < amount` refuses at its existing insufficient-funds branch. See `balanceOf`.
   */
  getMoney(type: 'bank' | 'cash'): number;
  /** `true` only when the framework said `true`. Anything else is a refusal — see `moved`. */
  removeMoney(type: 'bank' | 'cash', amount: number): boolean;
  /**
   * Credit a player.
   *
   * Absent until now, which meant money could only ever flow *out* of a player: `getMoney`
   * and `removeMoney` existed and nothing could pay anyone. A marketplace could take from a
   * buyer and had no way to pay the seller, so it was a noticeboard.
   *
   * Fails **closed** like `removeMoney` — returns false when the framework exposes no handler,
   * and equally when it answers with anything but a literal `true` — rather than the fail-open
   * pattern `removeInventoryItem` uses. That trade is defensible for a consumable whose effect
   * already happened; it is not defensible for money, where fail-open means inventing currency.
   */
  addMoney(type: 'bank' | 'cash', amount: number): boolean;
  setMeta(key: string, value: any): void;
  removeItem(item: string, count: number): boolean;
  rawPlayer: any;
}

/**
 * Another resource's exports.
 *
 * Indirected through a variable for one reason: under Vitest the bundler supplies its
 * own module-scope `exports` binding that shadows FiveM's global, so a test cannot put a
 * fake `qbx_core` where this module will look. Production evaluates exactly the same
 * expression it always did — see `__setResourceLookup`.
 */
export type ResourceLookup = (name: string) => any;

const realLookup: ResourceLookup = (name) => (exports as any)[name];

let lookup: ResourceLookup = realLookup;

/**
 * Reach another resource.
 *
 * A stable wrapper around the mutable `lookup` rather than the mutable binding itself, now
 * that the adapters live in other modules: an exported `let` would work under ESM's live
 * bindings and is one bundler behaviour away from not, and a test seam that silently stopped
 * taking effect would make every adapter suite pass against the real `exports` global.
 */
export const resource: ResourceLookup = (name) => lookup(name);

/** Test seam, like `__resetBatteryCache`. Pass nothing to restore the real lookup. */
export const __setResourceLookup = (fn?: ResourceLookup): void => {
  lookup = fn ?? realLookup;
};

/**
 * Does this resource expose this export? Used to *choose* a framework, never to call one.
 *
 * `exports` is a FiveM proxy that **throws** on a property whose resource is not running,
 * rather than answering `undefined` — the trap `client/lib/FrameworkBridge.ts` documents on
 * `getBankBalance`. Every framework branch below sits under one shared `try`, so before
 * MICA-150 that throw was harmless: it meant no qb core, and there was nothing after qb to
 * reach. With ESX added there is, and an unguarded probe for `qbx_core` on a pure ESX server
 * would abort the whole `getPlayer` before the ESX branch — the phone would never find a
 * player, and the one line in the console would name the wrong core.
 *
 * Swallowing is right *here* and only here, because a resource that is absent and a resource
 * that is present are the two answers this question has. Nothing below it swallows anything.
 */
export const exposes = (name: string, key: string): boolean => {
  try {
    return Boolean(resource(name)?.[key]);
  } catch {
    return false;
  }
};

/**
 * Everything below this line exists because `player` is `any` (MICA-133).
 *
 * The declarations on `FrameworkPlayer` — `removeMoney(): boolean`, `getMoney(): number` —
 * were decorative until now. Whatever qbx_core or qb-core handed back was returned straight
 * through, and `any` satisfies every signature, so TypeScript never objected. micaOS pins
 * `@citizenfx/*` exactly and pins neither of those resources: they belong to the operator and
 * move on the operator's schedule, which makes "RemoveMoney went async in the last release" an
 * ordinary event rather than a hypothetical.
 *
 * Every branch of that failure ran fail-open. A promise is truthy, so `!removeMoney(...)` never
 * tripped and `Payments` credited the payee whether or not the debit happened — money creation,
 * with no attacker, no error and no modified client. `Promise < amount` and `undefined < amount`
 * are both `false`, so the insufficient-funds check fell through to the debit the same way.
 *
 * `Payments` already declines to trust the framework's overdraw guard. These two coercions make
 * it decline to trust the framework's *answers* as well, which is the same decision applied one
 * level down.
 */

/** Enough of a description to make a framework upgrade recognisable in a server log. */
export const shapeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof (value as { then?: unknown }).then === 'function') return 'a promise';
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : `the number ${value}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} (${String(value)})`;
};

/**
 * Did money actually move?
 *
 * Only a literal `true` says so. A result object, a status code, a promise or `undefined` from
 * a renamed method all mean the same thing here — this code cannot tell — and the only safe
 * reading of "cannot tell" is that the move did not happen. Guessing the other way invents
 * currency, which is the one error no later correction fixes.
 *
 * A plain `false` is an ordinary refusal (an overdraw) and is not logged, for the same reason
 * `getPlayer` shouts about a nameless player but not an absent one. Only a *shapeless* answer
 * is evidence the contract moved.
 */
export const moved = (result: unknown, call: string, src: number): boolean => {
  if (typeof result === 'boolean') return result;
  console.error(
    `[FrameworkBridge] ${call} for source ${src} answered with ${shapeOf(result)} rather than ` +
      `a boolean. Treating the move as refused — the framework's contract has changed and ` +
      `this cannot tell whether the money moved.`
  );
  return false;
};

/**
 * A balance, or a number that cannot be afforded.
 *
 * `-Infinity` rather than `0` or a throw: every caller asks `balance < amount`, and the sentinel
 * has to make that true for *any* amount, including a zero-cost one, so the refusal lands at the
 * existing insufficient-funds check instead of somewhere new. It is also not a balance anyone
 * could arrive at honestly, so it cannot be confused for one.
 */
export const balanceOf = (result: unknown, call: string, src: number): number => {
  if (typeof result === 'number' && Number.isFinite(result)) return result;
  console.error(
    `[FrameworkBridge] ${call} for source ${src} answered with ${shapeOf(result)} rather than ` +
      `a finite number. Reporting the balance as undeterminable, which reads as unaffordable ` +
      `everywhere it is compared.`
  );
  return -Infinity;
};

/**
 * A loaded player the framework will not name.
 *
 * This used to synthesise `src_<source>` and carry on. A server id is not an identity:
 * it is assigned per connection and reused, so the next player to be given source 5
 * would have inherited the previous one's contacts, notes and photos — every
 * repository scopes by citizenid and this one looked perfectly valid.
 *
 * Returning null is what a missing player already does, and `ServiceEndpoint` answers
 * it with "Player not authenticated". A phone that refuses to open beats one showing
 * somebody else's messages.
 *
 * Module scope rather than a private static, because the ESX branches below are module-scope
 * functions and all three frameworks have to refuse an unnameable player the same way. A
 * second copy of this rule is a second place for it to stop being true.
 */
export const unidentified = (src: number, framework: string, why?: string): null => {
  console.error(
    `[FrameworkBridge] ${framework} returned a player for source ${src} with no usable ` +
      `citizenid${why ? ` — ${why}` : ''}. Refusing to serve micaOS data rather than ` +
      `inventing an identity.`
  );
  return null;
};

export interface OwnerTable {
  table: string;
  column: string;
}

/**
 * What a framework's own records say about a player, online or not.
 *
 * Names are separate rather than pre-joined because the two frameworks store them
 * differently — qb inside a `charinfo` JSON column, ESX as two columns — and joining them is
 * the caller's presentation decision. `phone` is nullable because on ESX it is genuinely
 * absent from core.
 */
export interface FrameworkIdentity {
  citizenid: string;
  firstname: string | null;
  lastname: string | null;
  phone: string | null;
}

/**
 * Which framework is answering for this server, including the two answers that are not a
 * framework.
 *
 * Declared here rather than beside `detectFramework` because every adapter names it and none
 * of them may import the module that does the detecting — that would be a cycle, since the
 * detecting is a fold over the adapters.
 */
export type FrameworkKind = 'qb' | 'esx' | 'standalone' | 'unknown';

/**
 * What every framework has to be able to answer.
 *
 * Four implementations, one per file, and `FrameworkBridge` picks between them rather than
 * branching inside each of its own methods. That is the whole of the refactor: the public
 * static surface is unchanged, and adding a framework is a new file plus one line in
 * `detectFramework`'s order rather than a new branch in nine methods.
 *
 * **`detect()` decides, and the order it is asked in is a compatibility decision, not a
 * preference.** A qb core wins over es_extended when both are installed, because a live
 * server does not change which string it calls a citizenid on the strength of a second
 * resource being present — that would re-key every row a player owns.
 */
export interface FrameworkAdapter {
  /** Which `FrameworkKind` this adapter answers for. `qbx_core` and `qb-core` are both `qb`. */
  readonly kind: Exclude<FrameworkKind, 'unknown'>;

  /**
   * Is this framework running on this server right now?
   *
   * What `detectFramework` folds over, and therefore what decides `ownerTable` and every
   * offline read. Distinct from the two capability probes below, because a FiveM resource
   * exposes each of its exports independently: a build can answer for a loaded player and
   * not for a list of them, and the code this replaces probed the specific export it was
   * about to call rather than the resource as a whole.
   */
  detect(): boolean;

  /**
   * ... and can it answer for a **loaded player**?
   *
   * Separate from `detect` because it is a separate probe in every adapter that has one —
   * ESX is present as soon as its shared object exists, but can only answer this once that
   * object exposes `GetPlayerFromId`. `FrameworkBridge.getPlayer` asks this, then commits:
   * a `null` afterwards means "not loaded", never "try the next core".
   */
  canGetPlayer(): boolean;

  getPlayer(src: number): FrameworkPlayer | null;

  /**
   * ... and can it **list** them?
   *
   * qbx exposes `GetPlayer` and `GetQBPlayers` as two exports, and a build with one and not
   * the other has to keep answering the way it always did. `{}` from here means "nobody
   * online", which is why it cannot double as "not my framework".
   */
  canListPlayers(): boolean;

  /** Every connected player, keyed by source, in the qb shape every caller reads. */
  getAllPlayers(): Record<string | number, any>;

  /**
   * Where this framework keeps the characters micaOS's rows belong to, or `null` when it
   * keeps none at all. Both fields are interpolated into SQL as identifiers, so an adapter
   * must return a frozen literal it wrote and never anything derived from a payload (§2.9).
   */
  ownerTable(): OwnerTable | null;

  findOfflineByCitizenId(citizenid: string): Promise<FrameworkIdentity | null>;
  findOfflineByCitizenIds(citizenids: readonly string[]): Promise<Map<string, FrameworkIdentity>>;
  findOfflineByPhone(phone: string): Promise<FrameworkIdentity | null>;

  /**
   * Register a usable item, if this framework has any such notion.
   *
   * Returns whether it was actually registered, so a caller can tell a real registration from
   * a silent no-op — the distinction `standaloneRegisterUsableItem` was written to make
   * audible rather than leaving it to look like success.
   */
  registerUsableItem(item: string, cb: (source: number) => void): boolean;
}

export const trimmedOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * `charinfo` comes back as a string from some drivers and an object from others, depending on
 * whether the column is `json` or `text` and on how oxmysql was configured. Both shapes reach
 * here, so both are handled rather than one being assumed — the same reason `Photos` coerces
 * its `image` column on the way out.
 */
export const parseCharinfo = (raw: unknown): Record<string, unknown> | null => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const identityFromCharinfo = (citizenid: string, raw: unknown): FrameworkIdentity => {
  const charinfo = parseCharinfo(raw);
  return {
    citizenid,
    firstname: trimmedOrNull(charinfo?.firstname),
    lastname: trimmedOrNull(charinfo?.lastname),
    phone: trimmedOrNull(charinfo?.phone)
  };
};

/**
 * An offline lookup that answers nothing rather than throwing.
 *
 * These read another resource's table, which micaOS neither creates nor migrates. The column
 * may be absent, the table may be absent, and on ESX the whole shape is a different framework
 * away — so a query here can fail for reasons that are not bugs in micaOS and must not become
 * an exception on a path that is only ever trying to render a name.
 *
 * Returning null degrades to exactly the pre-existing behaviour: an offline player with no
 * display name. That is a worse phone and a working one, where a throw would take down the
 * conversation being created around it. Logged once per distinct failure so a server owner
 * with a genuinely broken table is not left guessing.
 */
const offlineLookupFailures = new Set<string>();

export const offlineLookup = async <T>(
  what: string,
  run: () => Promise<T | null>
): Promise<T | null> => {
  try {
    return await run();
  } catch (error) {
    if (!offlineLookupFailures.has(what)) {
      offlineLookupFailures.add(what);
      console.error(
        `[FrameworkBridge] ${what} failed. Offline players will render without a name until ` +
          `this is fixed; nothing else is affected. Reported once per resource start.`,
        error
      );
    }
    return null;
  }
};

/** Test seam, like `__setResourceLookup`. */
export const __resetOfflineLookupWarnings = (): void => {
  offlineLookupFailures.clear();
};

/**
 * Consume an item through whatever inventory this server has.
 *
 * Module scope rather than a static on `FrameworkBridge`, because three adapters call it and
 * an adapter reaching back into the class that selects it would close a runtime cycle — the
 * same reason `lib/phoneNumbers.ts` exists apart from `services/PhoneNumbers.ts`.
 *
 * Deliberate fail-open, said out loud. A server with a framework but no recognized
 * inventory gets the item's effect without the item being consumed; the alternative
 * is a consumable that silently never works. A silent `return true` here reads as
 * "removed" to every caller, which is the same lie `shareContact` used to tell.
 */
export const removeInventoryItem = (
  src: number,
  player: any,
  item: string,
  count: number
): boolean => {
  if (player?.Functions?.RemoveItem) {
    return player.Functions.RemoveItem(item, count);
  }
  try {
    if (resource('ox_inventory')?.RemoveItem) {
      return resource('ox_inventory').RemoveItem(src, item, count);
    }
  } catch {
    // ox_inventory not present
  }

  console.warn(
    `[FrameworkBridge] No inventory resource could remove '${item}' for source ${src}. ` +
      `Allowing the action anyway — the item was not consumed.`
  );
  return true;
};

/**
 * How many of an item a player holds, through whatever inventory this server has, or `null`
 * when nothing here can count (MICA-229).
 *
 * The same walk `removeInventoryItem` makes, the other way round: ox_inventory first, because
 * on a qbx server it *is* the inventory and the core's own `GetItemByName` reads a mirror ox
 * maintains; then the qb player object; then ESX's xPlayer, which the ESX adapter keeps on
 * `rawPlayer.xPlayer` beside the qb-shaped view.
 *
 * `null` rather than `0` when no inventory answers, deliberately. The one caller is a gate,
 * and "nobody could count" must not read as "the player has none" -- that would lock every
 * phone on a server whose inventory this cannot see. What the gate does with `null` is its
 * decision, said out loud where it is made.
 */
export const countInventoryItem = (src: number, player: any, item: string): number | null => {
  const counted = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  if (exposes('ox_inventory', 'GetItemCount')) {
    return counted(resource('ox_inventory').GetItemCount(src, item));
  }
  if (typeof player?.Functions?.GetItemByName === 'function') {
    const found = player.Functions.GetItemByName(item);
    return counted(found?.amount ?? found?.count);
  }
  const xPlayer = player?.xPlayer ?? player;
  if (typeof xPlayer?.getInventoryItem === 'function') {
    return counted(xPlayer.getInventoryItem(item)?.count);
  }
  return null;
};
