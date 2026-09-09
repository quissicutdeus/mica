// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdFromIdentifier, describeIdentifierRejection } from '@mica/shared/framework';
import { Database } from '../Database';
import {
  balanceOf,
  booleanOf,
  exposes,
  moved,
  numberOr,
  offlineLookup,
  removeInventoryItem,
  resource,
  stringOr,
  trimmedOrNull,
  unidentified,
  type FrameworkAdapter,
  type FrameworkIdentity,
  type FrameworkJob,
  type FrameworkPlayer,
  type OwnerTable
} from './runtime';

/* ──────────────────────────────────────────────────────────────────────────────
 * ESX (`es_extended`)
 *
 * The third framework, and the first that does not share qb's shape. Everything below
 * exists so that an `xPlayer` reaches the rest of this server as the qb-shaped object it
 * already knows how to read — which is what keeps ESX support inside this one file.
 * ────────────────────────────────────────────────────────────────────────────── */

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
 * One reader: `Battery.ts` looks for a legacy `mica_battery` value on
 * `rawPlayer.PlayerData.metadata` when the player has no row in micaOS's own table yet.
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
 * `PlayerDirectory`, `Messages` and `Battery`. Normalising once, here, is what keeps ESX
 * knowledge confined to this file: the alternative is a framework check at each of those
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

/** micaOS's two money types in ESX's account names. `money` is ESX's word for cash. */
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
  return removeInventoryItem(src, {}, item, count);
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
 * resources; micaOS's own source of truth is its `mica_battery` table, which is written
 * either way. So a dropped mirror costs a third-party integration and never the phone — and
 * that is why the decision is degrade rather than refuse, which for a write with no reader
 * inside micaOS would only turn a missing integration into a broken battery.
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
      `[FrameworkBridge] This es_extended build exposes neither setMeta nor set, so micaOS ` +
        `cannot mirror metadata onto the framework player — '${key}' was dropped, first seen ` +
        `for source ${src}. micaOS's own tables are unaffected. Reported once per resource ` +
        `start, because this is a property of the build rather than of a player.`
    );
  }
};

/**
 * The raw ESX job table, through the accessor when there is one (MICA-227).
 *
 * `xPlayer.getJob()` is the Legacy accessor and `xPlayer.job` the table behind it — the
 * same "try the accessor, then the table" shape `esxVariable` uses, for the same reason.
 * Shape, from es_extended's documentation and **unverified against an installed copy**:
 * `{ name, label, grade, grade_name, grade_label, grade_salary, onDuty? }`, with `onDuty`
 * present only from Legacy 1.10.
 */
const esxRawJob = (xPlayer: any): any => {
  const viaGet = typeof xPlayer?.getJob === 'function' ? xPlayer.getJob() : undefined;
  return viaGet && typeof viaGet === 'object' ? viaGet : xPlayer?.job;
};

/**
 * The one job an ESX player holds, as a `FrameworkJob`.
 *
 * One, not several: core ESX keeps exactly one `job`, and esx_multijob and its forks each
 * keep the others in a table of their own that none of the others agree on, so they are
 * not read — `jobSupport` says so. `onDuty` is `null` unless the core field is a boolean,
 * because a pre-1.10 build has no duty at all and must not read as "off duty". `isBoss` is
 * `false`: core ESX has no boss flag on the job, and guessing at one add-on's field
 * would be right for one server and silently wrong for the rest.
 */
const esxJob = (xPlayer: any): FrameworkJob | null => {
  const raw = esxRawJob(xPlayer);
  const name = stringOr(raw?.name, '');
  if (!name) return null;
  const grade = numberOr(raw.grade, 0);
  return {
    name,
    label: stringOr(raw.label, name),
    grade,
    gradeLabel: stringOr(raw.grade_label, stringOr(raw.grade_name, String(grade))),
    salary: numberOr(raw.grade_salary, 0),
    onDuty: typeof raw.onDuty === 'boolean' ? raw.onDuty : null,
    isBoss: false,
    active: true
  };
};

/**
 * Clock the ESX job on or off, and prove it by reading `job.onDuty` back.
 *
 * `xPlayer.setJob(name, grade, onDuty)` — the Legacy 1.10 signature, whose third argument
 * is the duty flag; unverified against an installed copy. Refused outright when the current
 * job carries no boolean `onDuty`, because on such a build the third argument is ignored and
 * the re-read could never confirm anything. Refused quietly for any name but the active job.
 */
const esxSetDuty = (xPlayer: any, src: number, name: string, onDuty: boolean): boolean => {
  const raw = esxRawJob(xPlayer);
  if (!raw || raw.name !== name || typeof raw.onDuty !== 'boolean') return false;
  if (typeof xPlayer?.setJob !== 'function') return false;
  try {
    xPlayer.setJob(name, numberOr(raw.grade, 0), onDuty);
  } catch (error) {
    console.error(`[FrameworkBridge] ESX.setJob for source ${src} threw:`, error);
    return false;
  }
  return booleanOf(esxRawJob(xPlayer)?.onDuty, 'ESX job.onDuty', src) === onDuty;
};

/** An ESX `xPlayer` as a `FrameworkPlayer`, or null when it cannot be identified. */
const esxFrameworkPlayer = (xPlayer: any, src: number): FrameworkPlayer | null => {
  if (!xPlayer) return null;

  let identifier: unknown = xPlayer.identifier;
  if (identifier === undefined && typeof xPlayer.getIdentifier === 'function') {
    identifier = xPlayer.getIdentifier();
  }

  const citizenid = citizenIdFromIdentifier(identifier);
  if (!citizenid) return unidentified(src, 'es_extended', describeIdentifierRejection(identifier));

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
    getJobs: () => {
      const job = esxJob(xPlayer);
      return job ? [job] : [];
    },
    // One job, so there is nothing to switch to: true iff it is already the active one.
    setActiveJob: (name: string) => esxJob(xPlayer)?.name === name,
    setDuty: (name: string, onDuty: boolean) => esxSetDuty(xPlayer, src, name, onDuty),
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
 * es_extended. The table `findOfflineByCitizenId` already reads, asked a different way.
 *
 * A frozen literal, because both fields are interpolated into SQL as identifiers and MySQL
 * cannot parameterize one (§2.9). Nothing outside this module may supply either.
 */
const ESX_OWNER_TABLE: OwnerTable = Object.freeze({ table: 'users', column: 'identifier' });

/**
 * **ESX reads es_extended's own core `users` table and nothing else.** A phone number is not
 * in it — that belongs to whichever community resource an operator installed — so ESX answers
 * `phone: null` rather than adopting one project's schema and being wrong for everyone who
 * chose another.
 */
const findOfflineByCitizenId = async (citizenid: string): Promise<FrameworkIdentity | null> =>
  await offlineLookup('the es_extended `users` lookup by identifier', async () => {
    const row = await Database.single<{
      identifier: string;
      firstname: unknown;
      lastname: unknown;
    }>(
      `SELECT ${ESX_OWNER_TABLE.column}, firstname, lastname FROM ${ESX_OWNER_TABLE.table}
       WHERE ${ESX_OWNER_TABLE.column} = ? LIMIT 1`,
      [citizenid]
    );
    if (!row?.identifier) return null;
    return {
      citizenid: row.identifier,
      firstname: trimmedOrNull(row.firstname),
      lastname: trimmedOrNull(row.lastname),
      // Not in core ESX. See the note above.
      phone: null
    };
  });

/**
 * The same, for many, in one `IN (…)` (MICA-197).
 *
 * Bound parameters rather than a join onto `users`: micaOS pins `utf8mb4_unicode_ci` and
 * `users.identifier` takes the server default, so a column-to-column comparison is MySQL
 * errno 1267 on a stock MariaDB 11.4+. See the note above `FrameworkBridge`'s own
 * `findOfflineByCitizenIds`.
 */
const findOfflineByCitizenIds = async (
  citizenids: readonly string[]
): Promise<Map<string, FrameworkIdentity>> => {
  const found = new Map<string, FrameworkIdentity>();
  const placeholders = citizenids.map(() => '?').join(', ');

  await offlineLookup('the es_extended `users` lookup by identifier', async () => {
    const rows = await Database.query<
      { identifier: string; firstname: unknown; lastname: unknown }[]
    >(
      `SELECT ${ESX_OWNER_TABLE.column}, firstname, lastname FROM ${ESX_OWNER_TABLE.table}
       WHERE ${ESX_OWNER_TABLE.column} IN (${placeholders})`,
      [...citizenids]
    );
    for (const row of rows) {
      if (!row?.identifier) continue;
      found.set(row.identifier, {
        citizenid: row.identifier,
        firstname: trimmedOrNull(row.firstname),
        lastname: trimmedOrNull(row.lastname),
        phone: null
      });
    }
    return null;
  });

  return found;
};

/**
 * Where a community resource keeps the phone number on `users`, if anywhere (MICA-225).
 *
 * Core es_extended has no phone column, and the resources that add one disagree about its
 * name — the same three spellings `esxCharinfo` tries on the loaded player. So the offline
 * lookup by number used to answer nothing on ESX, which meant `GetCitizenId(phone)`, offline
 * mail and contact sharing all silently did nothing on the framework with the largest install
 * base. Rather than pick one project's column and be wrong for everyone who chose another,
 * this asks `information_schema` which of the three the table actually has, once per
 * resource start, and reads through that one.
 *
 * **A frozen allowlist, because the winner is interpolated as an identifier.** MySQL cannot
 * parameterize a column name (§2.9), so nothing that reaches SQL here may come from a payload
 * or from the table itself: the probe only ever narrows this list, and the list is written
 * here. `DATABASE()` scopes the probe to the schema the connection is on, so a leftover
 * `users` in another database on the same server cannot answer for this one.
 */
export const ESX_PHONE_COLUMNS: readonly string[] = Object.freeze([
  'phoneNumber',
  'phone_number',
  'phone'
]);

/** `undefined` until probed; `null` once probed and found nothing. */
let esxPhoneColumn: string | null | undefined;

/** Test seam, like `__resetEsxMetaWarning`. */
export const __resetEsxPhoneColumn = (): void => {
  esxPhoneColumn = undefined;
};

/**
 * The column, probed once. A probe that throws — no `users` table at all, no privilege on
 * `information_schema` — is answered `null` and said once by `offlineLookup`, so a broken
 * table degrades to "no offline lookup by number", which is exactly what ESX had before.
 */
const detectEsxPhoneColumn = async (): Promise<string | null> => {
  if (esxPhoneColumn !== undefined) return esxPhoneColumn;

  const found = await offlineLookup('the `users` phone-column probe', async () => {
    const placeholders = ESX_PHONE_COLUMNS.map(() => '?').join(', ');
    const rows = await Database.query<{ COLUMN_NAME: string }[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (${placeholders})`,
      [ESX_OWNER_TABLE.table, ...ESX_PHONE_COLUMNS]
    );
    const present = new Set((rows ?? []).map((row) => row?.COLUMN_NAME).filter(Boolean));
    // In allowlist order, so a table carrying two of them answers the same one every start.
    return ESX_PHONE_COLUMNS.find((column) => present.has(column)) ?? null;
  });

  esxPhoneColumn = found;
  console.log(
    found
      ? `[FrameworkBridge] es_extended: offline lookup by phone number reads \`users.${found}\`.`
      : `[FrameworkBridge] es_extended: \`users\` has none of ${ESX_PHONE_COLUMNS.join(', ')}, ` +
          `so an offline player cannot be found by phone number on this server. A loaded ` +
          `player still resolves. Reported once per resource start.`
  );
  return found;
};

/**
 * An offline ESX player by number, through whichever column the probe found.
 *
 * `null` on a server whose `users` carries no number, which is the same answer this gave
 * unconditionally before MICA-225: an offline player is simply not found, and every caller
 * already reads that as an unknown number.
 */
const findOfflineByPhone = async (phone: string): Promise<FrameworkIdentity | null> => {
  const column = await detectEsxPhoneColumn();
  if (!column) return null;

  return await offlineLookup('the es_extended `users` lookup by phone number', async () => {
    const row = await Database.single<{
      identifier: string;
      firstname: unknown;
      lastname: unknown;
    }>(
      `SELECT ${ESX_OWNER_TABLE.column}, firstname, lastname FROM ${ESX_OWNER_TABLE.table}
       WHERE \`${column}\` = ? LIMIT 1`,
      [phone]
    );
    if (!row?.identifier) return null;
    return {
      citizenid: row.identifier,
      firstname: trimmedOrNull(row.firstname),
      lastname: trimmedOrNull(row.lastname),
      phone
    };
  });
};

/**
 * The es_extended adapter.
 *
 * `detect` is `esxCore() !== null`, which is the same probe `getPlayer` used when this was one
 * file — and it stays *after* the qb probes in `detectFramework`'s order, because a server
 * running a qb core alongside es_extended keeps the identity it already has rows under.
 */
export const esxAdapter: FrameworkAdapter = {
  kind: 'esx',

  detect: () => esxCore() !== null,

  // Present is not the same as ready: an ESX shared object exists before it necessarily
  // exposes `GetPlayerFromId`, and the chain this replaces probed for that call itself.
  canGetPlayer: () => Boolean(esxCore()?.GetPlayerFromId),
  canListPlayers: () => esxCore() !== null,

  getPlayer: (src) => {
    const esx = esxCore();
    return esx?.GetPlayerFromId ? esxFrameworkPlayer(esx.GetPlayerFromId(src), src) : null;
  },

  // ESX records are normalised into the qb shape by `esxView`, so the callers of this outside
  // the framework directory need no framework check of their own.
  getAllPlayers: () => {
    const esx = esxCore();
    return esx ? esxAllPlayers(esx) : {};
  },

  ownerTable: () => ESX_OWNER_TABLE,

  findOfflineByCitizenId,
  findOfflineByCitizenIds,

  // Through whichever number column `users` turns out to have — see `ESX_PHONE_COLUMNS`.
  findOfflineByPhone,

  registerUsableItem: (item, cb) => {
    // `ESX.RegisterUsableItem(item, cb)` — same contract, one name over.
    const esx = esxCore();
    if (!esx?.RegisterUsableItem) return false;
    esx.RegisterUsableItem(item, cb);
    return true;
  },

  // `duty: false` at the adapter level even though a Legacy 1.10+ player can answer it:
  // whether `job.onDuty` exists is only knowable per loaded player, and the per-job
  // `onDuty: null` is what a caller keys on. The start-up line says the whole truth.
  jobSupport: () => ({
    multiJob: false,
    duty: false,
    via:
      'es_extended xPlayer.job (one job; duty only where job.onDuty is a boolean, Legacy ' +
      '1.10+; esx_multijob-style resources are not read)'
  })
};
