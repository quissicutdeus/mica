import { Transaction } from '@shared/types';

/**
 * Adapter over whichever banking resource the server runs, mirroring what
 * FrameworkBridge does for qbx/qb-core.
 *
 * gPhone must not read a banking resource's tables directly. Doing so couples the
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
