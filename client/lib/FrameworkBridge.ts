// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdFromIdentifier, describeIdentifierRejection } from '@mica/shared/framework';

/**
 * The client half of the framework bridge, and it is **display only**.
 *
 * Everything here answers a NUI callback in `client/client.ts` — bank balance, citizenid,
 * phone number — and the server believes none of it. `server/lib/FrameworkBridge.ts` resolves
 * the player again from the connection for every request (AGENTS.md §2.9), so a wrong answer
 * here is a wrong number on a screen and never a wrong row in a table.
 *
 * That is why there is no copy of MICA-133's `moved`/`balanceOf` coercions in this file, and
 * should not be. Those exist so a framework that changed its return type cannot be read as
 * "the money moved"; there is no money moving here, only a number being rendered. Their
 * sentinel would be actively wrong for a display: `-Infinity` on the bank screen is a bug
 * where on the server it is a refusal. This file's failure mode is deliberately `0` or `null`,
 * the same as it has always been.
 */

/** ESX's client-side accounts array, normalised to the qb `money` object. */
const esxMoney = (accounts: unknown): Record<string, number> => {
  const money: Record<string, number> = {};
  if (!Array.isArray(accounts)) return money;
  for (const account of accounts) {
    const name = (account as { name?: unknown })?.name;
    const value = (account as { money?: unknown })?.money;
    if (typeof name !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    // `money` is ESX's word for cash; every other account keeps its own name.
    money[name === 'money' ? 'cash' : name] = value;
  }
  return money;
};

/**
 * ESX's `PlayerData` wearing the qb shape, or null.
 *
 * The same trick the server bridge uses, for the same reason: `getBankBalance`,
 * `getCitizenId` and `getPhoneNumber` all read a qb-shaped object, so normalising once here
 * means none of them needs a framework branch. `accounts` is an array on ESX and an object on
 * qb, `identifier` is what `citizenid` means, and `charinfo` does not exist at all —
 * `firstName`/`lastName` are top-level and a phone number is not core ESX, so it is looked for
 * under the names community resources actually use and reported as absent otherwise.
 */
const identifierRefusals = new Set<string>();

const esxPlayerData = (data: any): any => {
  const citizenid = citizenIdFromIdentifier(data?.identifier);
  if (!citizenid) {
    // Display-only, so the authoritative complaint is the server bridge's — but a blank
    // phone is debugged from the player's F8 console, and this is the line that says why it
    // is blank rather than broken. Once per distinct reason per session: the cause is a
    // property of the framework's identifier format, not of the moment it was read, and
    // `getCitizenId` is on a path the UI can poll (MICA-158).
    const why = describeIdentifierRejection(data?.identifier);
    if (!identifierRefusals.has(why)) {
      identifierRefusals.add(why);
      console.error(
        `[FrameworkBridge] Refusing an ESX identity for display: ${why}. The server refuses ` +
          `it too, so this phone has no data. Reported once per distinct reason.`
      );
    }
    return null;
  }

  const phone = [data?.phoneNumber, data?.phone_number, data?.phone].find(
    (candidate) => typeof candidate === 'string' && candidate.trim() !== ''
  );

  return {
    citizenid,
    money: esxMoney(data?.accounts),
    charinfo: {
      firstname: typeof data?.firstName === 'string' ? data.firstName : '',
      lastname: typeof data?.lastName === 'string' ? data.lastName : '',
      phone: typeof phone === 'string' ? phone.trim() : null
    }
  };
};

/**
 * FiveM's `exports` proxy. The bare identifier is the real global in game, but under a
 * Node-based test runner it resolves to the module's own (empty) exports object — the same
 * trap `services/Call.ts` and the server's `Database.ts` document — so `globalThis` is asked
 * first. In the real client the two are the same object.
 */
const fx = (): any => (globalThis as any).exports ?? exports;

/**
 * Whether a framework's resource is running, asked without touching `exports`.
 *
 * `exports` is a FiveM proxy that **throws** on a resource it does not know rather than
 * answering `undefined`, so probing `qbx_core` through it on a qb or ESX server threw and was
 * caught on every lookup, and `GetPhoneNumber` is a client export any resource may poll
 * (MICA-355). The resource state answers the same question for the price of one native.
 */
const started = (resource: string): boolean => {
  try {
    return GetResourceState(resource) === 'started';
  } catch {
    return false;
  }
};

/**
 * Which frameworks to probe through `exports`, from their resource states.
 *
 * `blind` is the case where none of the three names reads 'started': a fork can `provide`
 * qb-core or es_extended under a resource name of its own, and then every state reads
 * 'missing' while the export still answers under the provided name. That case falls back to
 * probing all three through try/catch, as before MICA-355 — a standalone server lands here
 * too and pays the same throws it always did, so nothing gets worse for it.
 */
const frameworkProbes = (): { qbx: boolean; qb: boolean; esx: boolean } => {
  const qbx = started('qbx_core');
  const qb = started('qb-core');
  const esx = started('es_extended');
  const blind = !qbx && !qb && !esx;
  return { qbx: qbx || blind, qb: qb || blind, esx: esx || blind };
};

/**
 * Each framework's core object, fetched once rather than per lookup (MICA-355).
 *
 * `GetCoreObject()` and `getSharedObject()` copy the whole core across the export boundary —
 * `QBCore.Shared` and a funcref per function — and the phone only ever wants one function off
 * it. Caching the copy is safe because the functions on it are funcrefs into the framework's
 * live state: `Functions.GetPlayerData()` and `ESX.GetPlayerData()` answer the current
 * character on every call, not the one at fetch time. A framework restart invalidates those
 * funcrefs, so the cache is dropped whenever any client resource starts or stops, and a call
 * that throws refetches once before giving up.
 */
let qbCore: any = null;
let esxShared: any = null;

/**
 * Each distinct reason ESX was refused, so the console says it once per resource start
 * (MICA-421). Forgotten with the cached cores: a restart may be the owner installing Legacy,
 * and a refusal of the new build should be said again.
 */
const esxRefusals = new Set<string>();

/**
 * Any resource, not only `qb-core` and `es_extended`: a fork that `provide`s one of them starts
 * under its own name, and a funcref left from before a restart may answer nil rather than
 * throw, which would leave the phone blank until micaOS itself restarted. Starts and stops
 * are rare after join and the cost of a clear is one refetch on the next lookup.
 */
const dropCachedCores = (): void => {
  qbCore = null;
  esxShared = null;
  esxRefusals.clear();
};
on('onClientResourceStart', dropCachedCores);
on('onClientResourceStop', dropCachedCores);

/**
 * Refuse this server's ESX, out loud, and answer null.
 *
 * ESX older than Legacy is unsupported (MICA-421), so there is no `esx:getSharedObject` event
 * to fall back on and no `PlayerData` snapshot to read: either would be a quiet wait on a
 * build the phone does not promise to work with. The phone renders blank instead, and this is
 * the F8 line that says it is blank on purpose. Once per reason, because the cause is the
 * build that is installed and `GetPhoneNumber` is a client export any resource may poll.
 */
const refuseEsx = (why: string): null => {
  if (!esxRefusals.has(why)) {
    esxRefusals.add(why);
    console.error(
      `[FrameworkBridge] ${why} micaOS supports ESX Legacy only, reached through that ` +
        `export, so this phone has no ESX data. Reported once per distinct reason.`
    );
  }
  return null;
};

/**
 * The ESX Legacy shared object on the client, or null.
 *
 * `exports.es_extended.getSharedObject()` is the only route, as on the server (MICA-421). An
 * export lookup that throws is ESX being absent when `es_extended` is not running — the blind
 * probe of `frameworkProbes` lands here on every standalone server, and that is not a fault —
 * but the export being missing from a running `es_extended` is a pre-Legacy build, and says so.
 *
 * A shared object without `GetPlayerData` is not ready yet, as the server reads the same shape:
 * answered null in silence, never held, and fetched again on the next lookup. Its `PlayerData`
 * field is never read — that is a snapshot taken when the object was copied, stale from the
 * first character switch on.
 */
const fetchEsxCore = (): any => {
  let es: any;
  try {
    es = fx()['es_extended'];
    if (typeof es?.getSharedObject !== 'function') {
      return refuseEsx('es_extended exposes no getSharedObject export, so it predates ESX Legacy.');
    }
  } catch {
    if (!started('es_extended')) return null; // es_extended is not this server's framework.
    return refuseEsx(
      'es_extended is running without a getSharedObject export, so it predates ESX Legacy.'
    );
  }

  const esx = es.getSharedObject();
  return typeof esx?.GetPlayerData === 'function' ? esx : null;
};

const esxRawPlayerData = (): any => {
  if (esxShared) {
    try {
      return esxShared.GetPlayerData();
    } catch {
      // A stale funcref from before an es_extended restart — fetch the object again.
      esxShared = null;
    }
  }
  const esx = fetchEsxCore();
  if (!esx) return null;
  esxShared = esx;
  return esx.GetPlayerData();
};

const qbRawPlayerData = (): any => {
  if (qbCore) {
    try {
      return qbCore.Functions.GetPlayerData();
    } catch {
      // A stale funcref from before a qb-core restart — fetch the object again.
      qbCore = null;
    }
  }
  const core = fx()['qb-core'].GetCoreObject();
  const data = core.Functions.GetPlayerData();
  qbCore = core;
  return data;
};

export class FrameworkBridge {
  public static getPlayerData(): any {
    /**
     * One `try` per framework, and that is load-bearing rather than tidy.
     *
     * `exports` is a FiveM proxy that **throws** on a property whose resource is not there,
     * instead of answering `undefined` — the trap `getBankBalance` below already documents.
     * With all three branches under one `try`, a throw in one framework's lookup would be read
     * as "there is no framework" and the next branch never reached. `frameworkProbes` keeps a
     * framework that is not running from being touched at all; the separate `try`s keep a
     * broken one from hiding the next.
     */
    const probe = frameworkProbes();
    if (probe.qbx) {
      try {
        if (fx()['qbx_core']?.GetPlayerData) {
          return fx()['qbx_core'].GetPlayerData();
        }
      } catch {
        // Not this server's framework — try the next.
      }
    }

    if (probe.qb) {
      try {
        return qbRawPlayerData();
      } catch {
        // Not this server's framework — try the next.
        qbCore = null;
      }
    }

    // ESX last, matching the server bridge: a server with a qb core keeps the identity its
    // rows are already under.
    if (!probe.esx) return null;
    try {
      const data = esxRawPlayerData();
      return data ? esxPlayerData(data) : null;
    } catch (error) {
      esxShared = null;
      console.error('[FrameworkBridge] Error getting client PlayerData:', error);
      return null;
    }
  }

  public static getBankBalance(): number {
    // Separate try/catch from the PlayerData fallback below: FiveM's `exports` proxy
    // throws on property access for an export a resource does not register, so
    // `exports['qbx_core']?.GetMoney` throws rather than evaluating to `undefined` when
    // this qbx_core build has no `GetMoney` export. Letting that escape into the outer
    // try would skip the fallback entirely and always report a balance of 0.
    // `client/__tests__/FrameworkBridge.test.ts` fakes the throwing proxy.
    if (frameworkProbes().qbx) {
      try {
        if (fx()['qbx_core']?.GetMoney) {
          const balance = fx()['qbx_core'].GetMoney('bank');
          if (typeof balance === 'number') {
            return balance;
          }
        }
      } catch {
        // No GetMoney export on this qbx_core build — fall through to PlayerData below.
      }
    }

    try {
      // On ESX this reads the `bank` entry `esxMoney` lifted out of the accounts array, so
      // the qb-shaped fallback covers both frameworks and needs no branch of its own.
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.money?.bank ?? 0;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting bank balance:', error);
      return 0;
    }
  }

  public static getCitizenId(): string | null {
    try {
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.citizenid ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting citizenid:', error);
      return null;
    }
  }

  public static getPhoneNumber(): string | null {
    try {
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.charinfo?.phone ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting phone number:', error);
      return null;
    }
  }
}
