// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Transaction } from '@mica/shared/types';
import { exposes, resource, shapeOf } from './framework/runtime';

/**
 * Adapter over whichever banking resource the server runs, mirroring what
 * FrameworkBridge does for qbx/qb-core.
 *
 * micaOS must not read a banking resource's tables directly. Doing so couples the
 * phone to another script's schema, breaks on their migrations, and — for
 * Renewed-Banking specifically — reads stale data: their transactions live in an
 * in-memory cache that the `player_transactions` table lags behind. Their export
 * reads the cache, so it is both correct and fresher.
 *
 * Each adapter's job is to normalize. Banking scripts disagree about the shape of a
 * transaction, and most notably about sign: Renewed stores `amount` as always
 * positive with the direction in `trans_type`, so anything inferring direction from
 * a negative amount silently renders every withdrawal as a credit.
 */

type RawRecord = Record<string, unknown>;

const asNumber = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Renewed-Banking: `{ trans_id, title, amount, trans_type, receiver, message,
 * issuer, time }`, amount always positive, trans_type 'deposit' | 'withdraw'.
 */
const fromRenewed = (raw: RawRecord): Transaction => {
  const transType = asString(raw.trans_type)?.toLowerCase();
  return {
    id: asString(raw.trans_id) ?? '',
    title: asString(raw.title),
    // Normalized to a magnitude; direction is carried separately so no consumer
    // has to guess from a sign that may not be there.
    amount: Math.abs(asNumber(raw.amount)),
    direction: transType === 'withdraw' ? 'out' : 'in',
    message: asString(raw.message),
    issuer: asString(raw.issuer),
    receiver: asString(raw.receiver),
    time: asNumber(raw.time)
  };
};

/**
 * Normalize whatever Renewed-Banking handed back into the shared contract.
 *
 * Exported and pure so the mapping — which is where the real risk lives — is
 * testable without a FiveM runtime. `raw` is deliberately `unknown`: their export
 * returns `false`, not an empty array, for an account it has not cached.
 */
export function normalizeRenewedTransactions(raw: unknown): Transaction[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((record): record is RawRecord => !!record && typeof record === 'object')
    .map(fromRenewed)
    .sort((a, b) => b.time - a.time);
}

/**
 * A job name as every framework keys it — lower_snake_case. A society account key is a
 * framework job name passed on to a banking resource's export, so it is checked here even
 * though no client can name one (`Payments.payFromSociety` has no endpoint): the bridge is
 * the boundary, and a boundary that trusts its callers is one refactor from not being one.
 */
const SOCIETY_KEY = /^[a-z][a-z0-9_]*$/;
const isSocietyKey = (job: unknown): job is string =>
  typeof job === 'string' && SOCIETY_KEY.test(job);

interface SocietyBank {
  name: string;
  balance(job: string): unknown;
  add(job: string, amount: number): unknown;
  remove(job: string, amount: number): unknown;
}

/**
 * Whichever banking resource can hold a society account, or null.
 *
 * Probed per call rather than cached, like `detect()`: a banking resource restarts on its own
 * schedule. `exposes` swallows the throw FiveM's `exports` proxy raises for a resource that is
 * not running, so an absent resource is an ordinary miss.
 *
 * **Renewed-Banking is the only one verified against source** — vendored at
 * `vendor/Renewed-Banking/server/main.lua`: `getAccountMoney` (:192-200), `addAccountMoney`
 * (:207-215), `removeAccountMoney` (:258-270). All three take the account id, which for a
 * society is the job name (`GetJobAccount`, :568, keys `cachedAccounts` by it).
 *
 * **qb-banking and qb-management are from their published export names and are unverified
 * here** — neither is vendored on this server. qb-banking: `GetAccountBalance(name)`,
 * `AddMoney(name, amount, reason)`, `RemoveMoney(name, amount, reason)`. qb-management:
 * `GetAccount(job)`, `AddMoney(job, amount)`, `RemoveMoney(job, amount)`. Both are believed to
 * answer a boolean from the write calls; `moved` refuses anything else, so a mismatch reads as
 * a refusal rather than as a move.
 */
const societyBank = (): SocietyBank | null => {
  if (exposes('Renewed-Banking', 'getAccountMoney')) {
    const r = resource('Renewed-Banking');
    return {
      name: 'Renewed-Banking',
      balance: (job) => r.getAccountMoney(job),
      add: (job, amount) => r.addAccountMoney(job, amount),
      remove: (job, amount) => r.removeAccountMoney(job, amount)
    };
  }
  if (exposes('qb-banking', 'GetAccountBalance')) {
    const r = resource('qb-banking');
    return {
      name: 'qb-banking',
      balance: (job) => r.GetAccountBalance(job),
      add: (job, amount) => r.AddMoney(job, amount, 'micaOS'),
      remove: (job, amount) => r.RemoveMoney(job, amount, 'micaOS')
    };
  }
  if (exposes('qb-management', 'GetAccount')) {
    const r = resource('qb-management');
    return {
      name: 'qb-management',
      balance: (job) => r.GetAccount(job),
      add: (job, amount) => r.AddMoney(job, amount),
      remove: (job, amount) => r.RemoveMoney(job, amount)
    };
  }
  return null;
};

export class BankingBridge {
  /**
   * A player's transaction history, newest first.
   *
   * `citizenid` is the account key for a personal account. Returns [] rather than
   * throwing when no supported banking resource is present — a phone with no bank
   * script should show an empty list, not fail to open.
   */
  public static getTransactions(citizenid: string): Transaction[] {
    if (!citizenid) return [];
    return normalizeRenewedTransactions(BankingBridge.readRaw(citizenid));
  }

  /** Which banking resource answered, or null. Useful for a startup log. */
  public static detect(): string | null {
    try {
      if (typeof exports['Renewed-Banking']?.getAccountTransactions === 'function') {
        return 'Renewed-Banking';
      }
    } catch {
      // Resource absent; fall through.
    }
    return null;
  }

  /**
   * A society's balance, or `null` when nothing on this server can answer (MICA-227).
   *
   * `null` rather than `0`, deliberately: a Jobs app reading `0` would tell a boss the
   * account is empty, when the truth is that no banking resource is running. The two need
   * different screens.
   *
   * Only a finite number is believed. Renewed-Banking answers `false` for an account it
   * has not cached (`server/main.lua:194-199`, vendored), which is also `null` here — an
   * account that does not exist has no balance, and a society whose job has no account is
   * the ordinary state on a fresh install.
   */
  public static getSocietyBalance(job: string): number | null {
    if (!isSocietyKey(job)) return null;
    const bank = societyBank();
    if (!bank) return null;
    try {
      const result = bank.balance(job);
      if (typeof result === 'number' && Number.isFinite(result)) return result;
      if (result !== false && result !== undefined && result !== null) {
        console.error(
          `[BankingBridge] ${bank.name} answered a society balance for '${job}' with ` +
            `${shapeOf(result)} rather than a number. Reporting it as unknown.`
        );
      }
      return null;
    } catch (error) {
      console.error('[BankingBridge] Error reading a society balance:', error);
      return null;
    }
  }

  /**
   * Debit a society. `true` only when the banking resource answered a literal `true`
   * (`moved`, the same rule `FrameworkPlayer.removeMoney` lives by): a promise, a result
   * object or `undefined` all mean "cannot tell", and the only safe reading of that is that
   * nothing moved. Renewed refuses an unknown account and an overdraw with `false`
   * (`server/main.lua:258-270`).
   */
  public static removeSocietyMoney(job: string, amount: number): boolean {
    return BankingBridge.moveSociety('remove', job, amount);
  }

  /** The refund half of `removeSocietyMoney`. Renewed: `addAccountMoney`, `main.lua:207-215`. */
  public static addSocietyMoney(job: string, amount: number): boolean {
    return BankingBridge.moveSociety('add', job, amount);
  }

  private static moveSociety(direction: 'add' | 'remove', job: string, amount: number): boolean {
    if (!isSocietyKey(job) || !Number.isInteger(amount) || amount <= 0) return false;
    const bank = societyBank();
    if (!bank) return false;
    try {
      const result = direction === 'add' ? bank.add(job, amount) : bank.remove(job, amount);
      // The `moved` rule from framework/runtime.ts, restated for an account rather than a
      // source: a literal boolean is an answer, anything else is a contract that changed.
      if (typeof result === 'boolean') return result;
      console.error(
        `[BankingBridge] ${bank.name} answered ${direction} of ${amount} on society '${job}' ` +
          `with ${shapeOf(result)} rather than a boolean. Treating the move as refused.`
      );
      return false;
    } catch (error) {
      console.error(`[BankingBridge] Error moving society money (${direction}):`, error);
      return false;
    }
  }

  private static readRaw(citizenid: string): unknown {
    try {
      if (typeof exports['Renewed-Banking']?.getAccountTransactions === 'function') {
        // Cache-only on their side, and returns `false` for an unknown account.
        const result = exports['Renewed-Banking'].getAccountTransactions(citizenid);
        return result === false ? [] : result;
      }
    } catch (error) {
      console.error('[BankingBridge] Error reading transactions:', error);
    }

    return [];
  }
}
