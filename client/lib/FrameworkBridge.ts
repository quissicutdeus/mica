import { citizenIdFromIdentifier, describeIdentifierRejection } from '@shared/framework';

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
 * The ESX shared object on the client, or null.
 *
 * Mirrors `esxCore` on the server, including the `esx:getSharedObject` fallback for a build
 * predating the export. `exports` is a FiveM proxy that **throws** on a property it does not
 * know rather than answering `undefined` — the trap `getBankBalance` already documents — so
 * the lookup is inside the try rather than guarded by an optional chain.
 */
const esxCore = (): any => {
  try {
    const es = exports['es_extended'];
    if (es?.getSharedObject) return es.getSharedObject() ?? null;
  } catch {
    // es_extended is not this server's framework.
    return null;
  }

  try {
    let shared: any = null;
    emit('esx:getSharedObject', (obj: any) => {
      shared = obj;
    });
    return shared;
  } catch {
    return null;
  }
};

export class FrameworkBridge {
  public static getPlayerData(): any {
    /**
     * One `try` per framework, and that is load-bearing rather than tidy.
     *
     * `exports` is a FiveM proxy that **throws** on a property whose resource is not there,
     * instead of answering `undefined` — the trap `getBankBalance` below already documents.
     * With all three branches under one `try`, probing `qbx_core` on a pure ESX server throws
     * and the catch returns null, so "qbx_core is not installed" reads as "there is no
     * framework" and the ESX branch is never reached at all. The phone would simply never
     * find a player, with one line in the console blaming the wrong core.
     */
    try {
      if (exports['qbx_core']?.GetPlayerData) {
        return exports['qbx_core'].GetPlayerData();
      }
    } catch {
      // Not this server's framework — try the next.
    }

    try {
      if (exports['qb-core']?.GetCoreObject) {
        return exports['qb-core'].GetCoreObject().Functions.GetPlayerData();
      }
    } catch {
      // Not this server's framework — try the next.
    }

    // ESX last, matching the server bridge: a server with a qb core keeps the identity its
    // rows are already under.
    try {
      const esx = esxCore();
      // `ESX.GetPlayerData()` on Legacy, `ESX.PlayerData` on older builds.
      const data = typeof esx?.GetPlayerData === 'function' ? esx.GetPlayerData() : esx?.PlayerData;
      return data ? esxPlayerData(data) : null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting client PlayerData:', error);
      return null;
    }
  }

  public static getBankBalance(): number {
    // Separate try/catch from the PlayerData fallback below: FiveM's `exports` proxy
    // throws on property access for an export a resource does not register, so
    // `exports['qbx_core']?.GetMoney` throws rather than evaluating to `undefined` when
    // this qbx_core build has no `GetMoney` export. Letting that escape into the outer
    // try would skip the fallback entirely and always report a balance of 0. Not
    // covered by a test: `exports` is a FiveM runtime global that Vite shadows with a
    // per-module object (see `server/__tests__/BankingBridge.test.ts`), so a missing
    // export cannot be faked from a test — verifying this needs a running server.
    try {
      if (exports['qbx_core']?.GetMoney) {
        const balance = exports['qbx_core'].GetMoney('bank');
        if (typeof balance === 'number') {
          return balance;
        }
      }
    } catch {
      // No GetMoney export on this qbx_core build — fall through to PlayerData below.
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
