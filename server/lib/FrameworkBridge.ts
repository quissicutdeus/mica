import { citizenIdFromIdentifier } from '@shared/framework';
import { Database } from './Database';

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
type ResourceLookup = (name: string) => any;

let resource: ResourceLookup = (name) => (exports as any)[name];

/** Test seam, like `__resetBatteryCache`. Pass nothing to restore the real lookup. */
export const __setResourceLookup = (fn?: ResourceLookup): void => {
  resource = fn ?? ((name) => (exports as any)[name]);
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
const exposes = (name: string, key: string): boolean => {
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
 * through, and `any` satisfies every signature, so TypeScript never objected. gPhone pins
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
const shapeOf = (value: unknown): string => {
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
const moved = (result: unknown, call: string, src: number): boolean => {
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
const balanceOf = (result: unknown, call: string, src: number): number => {
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
const unidentified = (src: number, framework: string): null => {
  console.error(
    `[FrameworkBridge] ${framework} returned a player for source ${src} with no ` +
      `citizenid. Refusing to serve gPhone data rather than inventing an identity.`
  );
  return null;
};

/* ──────────────────────────────────────────────────────────────────────────────
 * ESX (`es_extended`)
 *
 * The third framework, and the first that does not share qb's shape. Everything below
 * exists so that an `xPlayer` reaches the rest of this server as the qb-shaped object it
 * already knows how to read — which is what keeps ESX support inside this one file.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * The identity decision itself lives in `shared/framework.ts`, because the client bridge has
 * to make it too and the two targets cannot import each other. Re-exported here so that the
 * one place a reader looks for how ESX identity works is the bridge that uses it.
 */
export { citizenIdFromIdentifier };

/**
 * The ESX shared object, or null when `es_extended` is not the framework here.
 *
 * `exports.es_extended.getSharedObject()` is the supported route on ESX Legacy. The
 * `esx:getSharedObject` event is the pre-Legacy one and is kept strictly as a fallback for a
 * build old enough to have no export — deliberately second, because it costs an event
 * dispatch on a path `getPlayer` walks for every request.
 *
 * Not cached, matching the qb branches, which call `GetCoreObject()` afresh every time. A
 * cached object survives an `ensure es_extended` and is then a handle onto a dead framework;
 * the call it replaces is a table lookup.
 */
const esxCore = (): any => {
  // Probed through `exposes` rather than accessed directly, for the reason it gives: on a
  // server with no es_extended this lookup throws rather than answering undefined, and that
  // throw would surface as "Error fetching all players" on a perfectly healthy qb server.
  if (exposes('es_extended', 'getSharedObject')) {
    return resource('es_extended').getSharedObject() ?? null;
  }

  try {
    if (!resource('es_extended')) return null;

    let shared: any = null;
    if (typeof emit === 'function') {
      emit('esx:getSharedObject', (obj: any) => {
        shared = obj;
      });
    }
    return shared;
  } catch {
    return null;
  }
};

/** A non-empty trimmed string, or null — ESX stores an absent value as `''` as often as nil. */
const esxString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * A player variable, under any of the names ESX and its addons have used for it.
 *
 * `xPlayer.get(key)` is the Legacy accessor, `xPlayer.variables[key]` is the table behind it,
 * and some addons write the field onto the player directly. All three are tried because the
 * alternative is picking one and having names render blank on every server that chose
 * another — silently, and looking like a UI bug rather than a bridge one. An accessor
 * installed by an addon can throw, which is treated as absent.
 */
const esxVariable = (xPlayer: any, ...keys: readonly string[]): string | null => {
  for (const key of keys) {
    try {
      const viaGet = typeof xPlayer?.get === 'function' ? xPlayer.get(key) : undefined;
      const found =
        esxString(viaGet) ?? esxString(xPlayer?.variables?.[key]) ?? esxString(xPlayer?.[key]);
      if (found) return found;
    } catch {
      // An accessor that throws is the same as one that is not there.
    }
  }
  return null;
};

/**
 * `charinfo`, as the rest of the server expects to find it.
 *
 * `PlayerDirectory`, `Messages` and `Music` all read `PlayerData.charinfo.firstname` and
 * `.lastname` to render a name, and `getPlayerByPhone` matches on `.phone`. ESX keeps the
 * first two as `firstName`/`lastName` (esx_identity), and **a phone number is not core ESX at
 * all** — the community resources that add one disagree about the field, so the likely
 * spellings are tried and a server keeping it elsewhere gets `null`, which every reader
 * already handles.
 *
 * `getName()` is the last resort, split on the first space: it is the one thing every ESX
 * build has, and a single name rendered as a first name beats a blank one.
 */
const esxCharinfo = (
  xPlayer: any
): { firstname: string; lastname: string; phone: string | null } => {
  let firstname = esxVariable(xPlayer, 'firstName', 'firstname');
  let lastname = esxVariable(xPlayer, 'lastName', 'lastname');

  if (!firstname && !lastname) {
    let full: string | null = null;
    try {
      full = typeof xPlayer?.getName === 'function' ? esxString(xPlayer.getName()) : null;
    } catch {
      full = null;
    }
    if (full) {
      const space = full.indexOf(' ');
      firstname = space === -1 ? full : full.slice(0, space);
      lastname = space === -1 ? null : esxString(full.slice(space + 1));
    }
  }

  return {
    firstname: firstname ?? '',
    lastname: lastname ?? '',
    phone: esxVariable(xPlayer, 'phoneNumber', 'phone_number', 'phone')
  };
};

/**
 * ESX metadata as a plain table, or undefined.
 *
 * One reader: `Battery.ts` looks for a legacy `gphone_battery` value on
 * `rawPlayer.PlayerData.metadata` when the player has no row in gPhone's own table yet.
 * `xPlayer.getMeta()` with no key returns the whole table on ESX Legacy 1.10+; anything older
 * has no metadata to offer, and that reader already falls back to a full battery.
 */
const esxMetadata = (xPlayer: any): Record<string, unknown> | undefined => {
  try {
    if (typeof xPlayer?.getMeta === 'function') {
      const all = xPlayer.getMeta();
      if (all && typeof all === 'object') return all as Record<string, unknown>;
    }
  } catch {
    // An ESX build with no metadata support.
  }
  return undefined;
};

/**
 * An `xPlayer` wearing the qb shape.
 *
 * `getAllPlayers()` hands its records to five callers outside this file — `proximity.ts`,
 * `appEvents.ts`, `Signal.ts`, `Mail.ts` and `Music.ts` — and every one of them reads
 * `PlayerData.citizenid` or `PlayerData.charinfo` off them, as do the `rawPlayer` readers in
 * `PlayerDirectory`, `Messages` and `Battery`. Normalising once, here, is what keeps the ESX
 * adapter inside `FrameworkBridge`: the alternative is a framework check at each of those
 * eight sites, which is the duplication `getSourcesByCitizenId` was written to avoid.
 *
 * The real `xPlayer` is kept on `.xPlayer` rather than discarded, so anything that genuinely
 * needs ESX's own API has a route to it that is not another `exports` lookup.
 */
const esxView = (xPlayer: any, citizenid: string, src: number) => ({
  PlayerData: {
    citizenid,
    source: src,
    charinfo: esxCharinfo(xPlayer),
    metadata: esxMetadata(xPlayer)
  },
  xPlayer
});

/** gPhone's two money types in ESX's account names. `money` is ESX's word for cash. */
const ESX_ACCOUNT: Record<'bank' | 'cash', string> = { bank: 'bank', cash: 'money' };

/** A balance off an ESX account, coerced by the same rule as every other framework answer. */
const esxBalance = (xPlayer: any, type: 'bank' | 'cash', src: number): number => {
  const account = ESX_ACCOUNT[type];
  const call = `ESX.getAccount('${account}')`;
  try {
    if (typeof xPlayer?.getAccount === 'function') {
      return balanceOf(xPlayer.getAccount(account)?.money, call, src);
    }
    // Pre-account ESX exposes cash only, and only through `getMoney()`.
    if (type === 'cash' && typeof xPlayer?.getMoney === 'function') {
      return balanceOf(xPlayer.getMoney(), 'ESX.getMoney', src);
    }
  } catch (error) {
    console.error(`[FrameworkBridge] ${call} for source ${src} threw:`, error);
    return -Infinity;
  }
  return balanceOf(undefined, call, src);
};

/**
 * Move money on an ESX account, and prove it moved by reading the balance back.
 *
 * qb answers a money call with a boolean, so MICA-133's `moved` has something to judge.
 * **ESX's `addAccountMoney` and `removeAccountMoney` return nothing at all** — there is no
 * answer to coerce. Handing their `undefined` to `moved` would refuse every ESX transfer
 * that ever worked; treating "it did not throw" as success is exactly the fail-open
 * MICA-133 closed, one framework over. Neither is acceptable, so this asks the only source
 * that can settle it: the account itself.
 *
 * Both reads go through `esxBalance`, so they are coerced exactly like `getMoney` — a
 * `getAccount` that starts answering with a promise refuses here too, instead of producing a
 * comparison between two sentinels. The verdict then goes through `moved`, so there is still
 * one helper in this file that decides what "the money moved" means and one place a future
 * framework surprise has to get past.
 *
 * **It refuses before calling the framework** when the opening balance is undeterminable. A
 * blind write followed by a read it cannot interpret is strictly worse than not writing: it
 * manufactures the stranded case rather than avoiding it.
 *
 * ESX is single-threaded and both calls are synchronous, so nothing can move the balance
 * between the two reads. The comparison is `>=` in the requested direction rather than an
 * equality, because ESX rounds through `ESX.Math.Round`: a rounding unit of over-movement is
 * the framework's arithmetic, while anything that moved *less* than asked is the failure this
 * exists to catch.
 *
 * **It does not refuse an overdraw, and no framework branch here does.** qb's `RemoveMoney`
 * answers `false` when the player cannot afford it; ESX's `removeAccountMoney` takes the
 * account negative and this reads that as a completed debit, because it is one. Both callers
 * — `Payments.ts` and `Hodlr.ts` — check `getMoney` first for exactly this reason, stated at
 * `Payments.ts`: frameworks disagree about whether an overdraw refuses or clamps, so the
 * affordability decision does not belong to the framework. A guard here would put it back.
 */
const esxMove = (
  xPlayer: any,
  direction: 'credit' | 'debit',
  type: 'bank' | 'cash',
  amount: number,
  src: number
): boolean => {
  const account = ESX_ACCOUNT[type];
  const method = direction === 'credit' ? 'addAccountMoney' : 'removeAccountMoney';
  const call = `ESX.${method}('${account}')`;

  if (typeof xPlayer?.[method] !== 'function') return moved(undefined, call, src);

  const before = esxBalance(xPlayer, type, src);
  if (!Number.isFinite(before)) return false; // `esxBalance` has already said why.

  try {
    xPlayer[method](account, amount);
  } catch (error) {
    console.error(`[FrameworkBridge] ${call} for source ${src} threw:`, error);
    return false;
  }

  const after = esxBalance(xPlayer, type, src);
  if (!Number.isFinite(after)) {
    console.error(
      `[FrameworkBridge] ${call} for source ${src} cannot be confirmed: the balance was ` +
        `readable before the call and is not after. Treating the move as refused — but it ` +
        `may have happened, so reconcile this account by hand.`
    );
    return false;
  }

  const settled = direction === 'credit' ? after >= before + amount : after <= before - amount;

  if (!settled && direction === 'credit') {
    // A debit that does not land is an ordinary overdraw, which ESX refuses silently the way
    // a qb `RemoveMoney` returns a plain `false` — not worth a line. A *credit* that does not
    // land is not ordinary: nothing was supposed to be able to decline it.
    console.error(
      `[FrameworkBridge] ${call} for source ${src} left the balance at ${after} after being ` +
        `asked to add ${amount} to ${before}. Treating the credit as refused.`
    );
  }

  return moved(settled, call, src);
};

/**
 * Consume an item from an ESX inventory.
 *
 * `xPlayer.removeInventoryItem` returns nothing, like ESX's money calls — but unlike money
 * this is allowed to fail open, because that is already the stated policy for items (see
 * `removeInventoryItem` below and the warning it prints). The trade is the one made there: a
 * consumable whose effect has already happened is not worth refusing over, and money is.
 * There is nothing to coerce because there is nothing returned.
 *
 * Falls through to the shared helper — and so to ox_inventory, which is common on ESX — when
 * the player object has no inventory call of its own.
 */
const esxRemoveItem = (xPlayer: any, src: number, item: string, count: number): boolean => {
  try {
    if (typeof xPlayer?.removeInventoryItem === 'function') {
      xPlayer.removeInventoryItem(item, count);
      return true;
    }
  } catch (error) {
    console.error(`[FrameworkBridge] ESX.removeInventoryItem('${item}') for ${src} threw:`, error);
    return false;
  }
  return FrameworkBridge.removeInventoryItem(src, {}, item, count);
};

/**
 * Whether this build has already been reported as having nowhere to put metadata.
 *
 * A single flag, not a set of sources. What is being reported is a property of the
 * **es_extended build** — either it exposes `setMeta`/`set` or it does not — and that answer
 * is the same for every player on the server, so there is nothing per-player to remember.
 *
 * It was a `Set<number>` first, and that was wrong twice over: nothing removed from it, so it
 * grew for the life of the resource, and FiveM recycles server ids, so a recycled id would
 * stay silenced for whoever was assigned it next. `lib/rateLimit.ts`'s `forgetSource` and
 * `lib/shell.ts`'s `refusalsLogged` both clear on `playerDropped` for that second reason.
 * The fix here is not to clear it but to stop keying it per player, which also spares this
 * module a `playerDropped` handler it has never needed.
 */
let esxMetaUnsupportedReported = false;

/** Test seam, like `__setResourceLookup`. */
export const __resetEsxMetaWarning = (): void => {
  esxMetaUnsupportedReported = false;
};

/**
 * `setMeta` on ESX **degrades; it is not unsupported.**
 *
 * ESX Legacy 1.10+ has `xPlayer.setMeta`, which is the real twin and is used when present.
 * Older builds have only `xPlayer.set`, which writes a session variable that is not persisted
 * across a reconnect — less than qb offers, and honest about what it is. A build with neither
 * drops the write and says so once per player.
 *
 * Degrading is safe here specifically because of who calls it. The only caller is
 * `Battery.ts`, mirroring the charge onto the framework player for the benefit of *other*
 * resources; gPhone's own source of truth is its `gphone_battery` table, which is written
 * either way. So a dropped mirror costs a third-party integration and never the phone — and
 * that is why the decision is degrade rather than refuse, which for a write with no reader
 * inside gPhone would only turn a missing integration into a broken battery.
 */
const esxSetMeta = (xPlayer: any, src: number, key: string, value: any): void => {
  try {
    if (typeof xPlayer?.setMeta === 'function') {
      xPlayer.setMeta(key, value);
      return;
    }
    if (typeof xPlayer?.set === 'function') {
      xPlayer.set(key, value);
      return;
    }
  } catch (error) {
    console.error(`[FrameworkBridge] ESX setMeta('${key}') for source ${src} failed:`, error);
    return;
  }

  if (!esxMetaUnsupportedReported) {
    esxMetaUnsupportedReported = true;
    console.warn(
      `[FrameworkBridge] This es_extended build exposes neither setMeta nor set, so gPhone ` +
        `cannot mirror metadata onto the framework player — '${key}' was dropped, first seen ` +
        `for source ${src}. gPhone's own tables are unaffected. Reported once per resource ` +
        `start, because this is a property of the build rather than of a player.`
    );
  }
};

/** An ESX `xPlayer` as a `FrameworkPlayer`, or null when it cannot be identified. */
const esxFrameworkPlayer = (xPlayer: any, src: number): FrameworkPlayer | null => {
  if (!xPlayer) return null;

  let identifier: unknown = xPlayer.identifier;
  if (identifier === undefined && typeof xPlayer.getIdentifier === 'function') {
    identifier = xPlayer.getIdentifier();
  }

  const citizenid = citizenIdFromIdentifier(identifier);
  if (!citizenid) return unidentified(src, 'es_extended');

  const view = esxView(xPlayer, citizenid, src);

  return {
    citizenid,
    source: src,
    phone: view.PlayerData.charinfo.phone ?? undefined,
    getMoney: (type: 'bank' | 'cash') => esxBalance(xPlayer, type, src),
    removeMoney: (type: 'bank' | 'cash', amount: number) =>
      esxMove(xPlayer, 'debit', type, amount, src),
    addMoney: (type: 'bank' | 'cash', amount: number) =>
      esxMove(xPlayer, 'credit', type, amount, src),
    setMeta: (key: string, value: any) => esxSetMeta(xPlayer, src, key, value),
    removeItem: (item: string, count: number) => esxRemoveItem(xPlayer, src, item, count),
    // The qb-shaped view, not the bare xPlayer: `PlayerDirectory`, `Messages` and `Battery`
    // all read `rawPlayer.PlayerData`. ESX's own object is on `rawPlayer.xPlayer`.
    rawPlayer: view
  };
};

/**
 * Every connected ESX player, keyed by source, in the qb shape.
 *
 * Three accessors, tried in order, because they arrived in that order and a given build may
 * ship any of them: `GetExtendedPlayers()` (Legacy, xPlayers), the `ESX.Players` table behind
 * it, and `GetPlayers()` (ids only, oldest). The fan-out in `pushMany`, `proximity` and
 * `Signal` should not depend on which one an operator happens to be running.
 */
const esxAllPlayers = (core: any): Record<number, unknown> => {
  const out: Record<number, unknown> = {};

  const add = (xPlayer: any): void => {
    const src = Number(xPlayer?.source);
    if (!Number.isFinite(src)) return;
    const citizenid = citizenIdFromIdentifier(xPlayer?.identifier);
    // Never list a player this cannot name — the reasoning is `unidentified`'s, and a
    // nameless entry here would reach `proximity` and `pushMany` as a real recipient.
    if (!citizenid) return;
    out[src] = esxView(xPlayer, citizenid, src);
  };

  const extended =
    typeof core?.GetExtendedPlayers === 'function' ? core.GetExtendedPlayers() : null;
  if (Array.isArray(extended) && extended.length > 0) {
    for (const xPlayer of extended) add(xPlayer);
    return out;
  }

  if (core?.Players && typeof core.Players === 'object') {
    for (const key of Object.keys(core.Players)) add(core.Players[key]);
    if (Object.keys(out).length > 0) return out;
  }

  if (typeof core?.GetPlayers === 'function' && typeof core?.GetPlayerFromId === 'function') {
    const ids = core.GetPlayers();
    if (Array.isArray(ids)) for (const id of ids) add(core.GetPlayerFromId(Number(id)));
  }

  return out;
};

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
 * Is es_extended the framework answering for this server?
 *
 * A qb core wins when both are installed, matching `getPlayer`: a live server does not change
 * which string it calls a citizenid on the strength of a second resource being present. With
 * no framework at all this is false, so the offline lookups below fall through to the qb
 * query — which is what they did before ESX existed, and what keeps a frameworkless test
 * behaving as it always has.
 */
const usesEsx = (): boolean =>
  !exposes('qbx_core', 'GetPlayer') && !exposes('qb-core', 'GetCoreObject') && esxCore() !== null;

const trimmedOrNull = (value: unknown): string | null => {
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
const parseCharinfo = (raw: unknown): Record<string, unknown> | null => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const identityFromCharinfo = (citizenid: string, raw: unknown): FrameworkIdentity => {
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
 * These read another resource's table, which gPhone neither creates nor migrates. The column
 * may be absent, the table may be absent, and on ESX the whole shape is a different framework
 * away — so a query here can fail for reasons that are not bugs in gPhone and must not become
 * an exception on a path that is only ever trying to render a name.
 *
 * Returning null degrades to exactly the pre-existing behaviour: an offline player with no
 * display name. That is a worse phone and a working one, where a throw would take down the
 * conversation being created around it. Logged once per distinct failure so a server owner
 * with a genuinely broken table is not left guessing.
 */
const offlineLookupFailures = new Set<string>();

const offlineLookup = async <T>(what: string, run: () => Promise<T | null>): Promise<T | null> => {
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

export class FrameworkBridge {
  /**
   * The framework's record of a player who may be offline, by citizenid.
   *
   * Behind the bridge rather than in `PlayerDirectory` because it is a framework question:
   * qb keeps players in `players(citizenid)` with a `charinfo` JSON column, ESX keeps them in
   * `users(identifier)` with `firstname`/`lastname` columns, and every other framework will
   * keep them somewhere else again. `PlayerDirectory` asks who somebody is; this knows where
   * to look.
   *
   * **ESX reads es_extended's own core `users` table and nothing else.** A phone number is
   * not in it — that belongs to whichever community resource an operator installed — so ESX
   * answers `phone: null` here rather than adopting one project's schema and being wrong for
   * everyone who chose another.
   */
  public static async findOfflineByCitizenId(citizenid: string): Promise<FrameworkIdentity | null> {
    if (!citizenid) return null;

    if (usesEsx()) {
      return await offlineLookup('the es_extended `users` lookup by identifier', async () => {
        const row = await Database.single<{
          identifier: string;
          firstname: unknown;
          lastname: unknown;
        }>('SELECT identifier, firstname, lastname FROM users WHERE identifier = ? LIMIT 1', [
          citizenid
        ]);
        if (!row?.identifier) return null;
        return {
          citizenid: row.identifier,
          firstname: trimmedOrNull(row.firstname),
          lastname: trimmedOrNull(row.lastname),
          // Not in core ESX. See the note above.
          phone: null
        };
      });
    }

    return await offlineLookup('the `players` lookup by citizenid', async () => {
      const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
        'SELECT citizenid, charinfo FROM players WHERE citizenid = ? LIMIT 1',
        [citizenid]
      );
      if (!row?.citizenid) return null;
      return identityFromCharinfo(row.citizenid, row.charinfo);
    });
  }

  /**
   * The same, by phone number.
   *
   * **ESX cannot answer this, and says so by answering nothing.** Core `users` has no phone
   * column, so there is nothing to match on; guessing at `esx_phone`'s or another resource's
   * table would be right for one server population and silently wrong for the rest. The
   * caller already handles null — an offline player is simply not found — which is the same
   * outcome as an unknown number.
   */
  public static async findOfflineByPhone(phone: string): Promise<FrameworkIdentity | null> {
    if (!phone) return null;
    if (usesEsx()) return null;

    return await offlineLookup('the `players` lookup by phone number', async () => {
      const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
        `SELECT citizenid, charinfo FROM players
     WHERE JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.phone')) = ?
     LIMIT 1`,
        [phone]
      );
      if (!row?.citizenid) return null;
      return identityFromCharinfo(row.citizenid, row.charinfo);
    });
  }

  public static getPlayer(src: number): FrameworkPlayer | null {
    try {
      // QBX Core
      if (exposes('qbx_core', 'GetPlayer')) {
        const player = resource('qbx_core').GetPlayer(src);
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid || player.citizenid;
        if (!citizenid) return unidentified(src, 'qbx_core');
        const phone = player.PlayerData?.charinfo?.phone || null;
        return {
          citizenid,
          source: src,
          phone,
          getMoney: (type: 'bank' | 'cash') => {
            if (player.Functions?.GetMoney)
              return balanceOf(player.Functions.GetMoney(type), 'GetMoney', src);
            if (resource('qbx_core')?.GetMoney)
              return balanceOf(resource('qbx_core').GetMoney(src, type), 'qbx_core.GetMoney', src);
            // The player table, which is data rather than a call, and just as capable of
            // holding a string where a number is declared.
            return balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src);
          },
          removeMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.RemoveMoney)
              return moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src);
            return false;
          },
          addMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.AddMoney)
              return moved(player.Functions.AddMoney(type, amount), 'AddMoney', src);
            if (resource('qbx_core')?.AddMoney)
              return moved(
                resource('qbx_core').AddMoney(src, type, amount),
                'qbx_core.AddMoney',
                src
              );
            return false;
          },
          setMeta: (key: string, value: any) => {
            if (player.Functions?.SetMetaData) {
              player.Functions.SetMetaData(key, value);
            } else if (player.PlayerData?.metadata) {
              player.PlayerData.metadata[key] = value;
            }
            try {
              if (resource('qbx_core')?.SetMetaData) {
                resource('qbx_core').SetMetaData(src, key, value);
              }
            } catch {
              // ignore
            }
          },
          removeItem: (item: string, count: number) => {
            return FrameworkBridge.removeInventoryItem(src, player, item, count);
          },
          rawPlayer: player
        };
      }

      // QB Core
      if (exposes('qb-core', 'GetCoreObject')) {
        const QBCore = resource('qb-core').GetCoreObject();
        const player = QBCore?.Functions?.GetPlayer ? QBCore.Functions.GetPlayer(src) : null;
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid;
        if (!citizenid) return unidentified(src, 'qb-core');
        const phone = player.PlayerData?.charinfo?.phone || null;
        return {
          citizenid,
          source: src,
          phone,
          getMoney: (type: 'bank' | 'cash') =>
            player.Functions?.GetMoney
              ? balanceOf(player.Functions.GetMoney(type), 'GetMoney', src)
              : balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src),
          removeMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.RemoveMoney
              ? moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src)
              : false,
          addMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.AddMoney
              ? moved(player.Functions.AddMoney(type, amount), 'AddMoney', src)
              : false,
          setMeta: (key: string, value: any) => {
            if (player.Functions?.SetMetaData) {
              player.Functions.SetMetaData(key, value);
            } else if (player.PlayerData?.metadata) {
              player.PlayerData.metadata[key] = value;
            }
          },
          removeItem: (item: string, count: number) => {
            return FrameworkBridge.removeInventoryItem(src, player, item, count);
          },
          rawPlayer: player
        };
      }

      // ESX. Last, so a server running a qb core and es_extended side by side keeps the
      // identity it already has rows under — switching a live server's citizenid scheme is a
      // data migration, not a fallback.
      const esx = esxCore();
      if (esx?.GetPlayerFromId) {
        return esxFrameworkPlayer(esx.GetPlayerFromId(src), src);
      }
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

  public static getAllPlayers(): Record<string | number, any> {
    try {
      if (exposes('qbx_core', 'GetQBPlayers')) {
        return resource('qbx_core').GetQBPlayers() || {};
      } else if (exposes('qb-core', 'GetCoreObject')) {
        const QBCore = resource('qb-core').GetCoreObject();
        return QBCore?.Functions?.GetQBPlayers ? QBCore.Functions.GetQBPlayers() : {};
      }

      // ESX records are normalised into the qb shape by `esxView`, so the five callers of
      // this outside `FrameworkBridge` need no framework check of their own.
      const esx = esxCore();
      if (esx) return esxAllPlayers(esx);
    } catch (error) {
      console.error('[FrameworkBridge] Error fetching all players:', error);
    }
    return {};
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
   * Server ids for many citizenids, from one snapshot.
   *
   * `getSourceByCitizenId` walks `getAllPlayers()` per call, so notifying forty followers was
   * forty full walks. One pass here, and the single lookup is reimplemented on top so there is
   * still only one place that knows the framework's shape.
   */
  public static getSourcesByCitizenId(citizenids: readonly string[]): Map<string, number> {
    const found = new Map<string, number>();
    if (citizenids.length === 0) return found;

    const wanted = new Set(citizenids.filter(Boolean));
    if (wanted.size === 0) return found;

    try {
      const players = FrameworkBridge.getAllPlayers();
      for (const src in players) {
        const citizenid = players[src]?.PlayerData?.citizenid;
        if (citizenid && wanted.has(citizenid)) found.set(citizenid, parseInt(src, 10));
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

  public static removeInventoryItem(
    src: number,
    player: any,
    item: string,
    count: number
  ): boolean {
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

    // Deliberate fail-open, said out loud. A server with a framework but no recognized
    // inventory gets the item's effect without the item being consumed; the alternative
    // is a consumable that silently never works. A silent `return true` here reads as
    // "removed" to every caller, which is the same lie `shareContact` used to tell.
    console.warn(
      `[FrameworkBridge] No inventory resource could remove '${item}' for source ${src}. ` +
        `Allowing the action anyway — the item was not consumed.`
    );
    return true;
  }

  public static registerUsableItem(item: string, cb: (source: number) => void): void {
    try {
      if (exposes('qbx_core', 'CreateUseableItem')) {
        resource('qbx_core').CreateUseableItem(item, cb);
      } else if (exposes('qb-core', 'GetCoreObject')) {
        const QBCore = resource('qb-core').GetCoreObject();
        if (QBCore?.Functions?.CreateUseableItem) {
          QBCore.Functions.CreateUseableItem(item, cb);
        }
      } else {
        // `ESX.RegisterUsableItem(item, cb)` — same contract, one name over.
        const esx = esxCore();
        if (esx?.RegisterUsableItem) esx.RegisterUsableItem(item, cb);
      }
    } catch (error) {
      console.error(`[FrameworkBridge] Framework item registration skipped for '${item}':`, error);
    }
  }
}
