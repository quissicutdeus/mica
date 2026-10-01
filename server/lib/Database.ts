// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TransactionQuery {
  query: string;
  params?: any[];
}

/**
 * How long an unanswered call may stay outstanding before `Database` gives up on it and
 * rejects, in milliseconds.
 *
 * A minute, the same threshold `HodlrMarket.ts`'s own MICA-130 fix already judged
 * tolerable for exactly this failure — see `withTimeout` below for why the two are not the
 * same mechanism even though they agree on the number. Long enough that a slow write of a
 * `mediumtext` photo does not fail spuriously under real load; short enough that an operator
 * watching a boot log sees a real error inside the same minute rather than a silent hang.
 */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * MICA-160. oxmysql's own source rejects correctly once a query reaches a connection and
 * fails — but a query issued *before the pool has a connection at all* never invokes its
 * callback, ever. Nothing upstream of `oxmysql` ever timed out either, so every static
 * method here returned a promise that could simply never settle: not resolve, not reject.
 *
 * That is not the same failure `oxmysql`'s documented behaviour suggests, and it bites hardest
 * at the moment it is least visible — a query issued at resource start, before the pool has
 * connected, or anything mid-`restart oxmysql`. A hung boot-time `await` never runs the code
 * after it, never logs, and never reports; the resource just looks like it started and did
 * nothing.
 *
 * `Promise.race` against a timer is the whole fix: it does not, and cannot, cancel the
 * underlying `oxmysql` call — there is no cancellation handle to call. If that real call
 * later does settle, its result is simply unreferenced once this has already rejected on the
 * caller's behalf. That is safe for a read, whose only effect is the value it hands back. It
 * is an accepted, once-considered risk for a write that lands *after* the timeout already
 * told a caller it failed: a caller that took a compensating action on the strength of that
 * rejection (a refund, a retry) could in principle race a late, real success. Nothing in this
 * codebase currently retries a `Database` write on rejection without first re-reading state
 * (Payments.ts's own refund path re-reads nothing — it is itself a debit only committed after
 * the earlier debit succeeded), so this is judged an acceptable trade against the alternative,
 * which is the outage this ticket exists to fix.
 */
const withTimeout = <T>(label: string, promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`[Database] ${label} did not answer within ${QUERY_TIMEOUT_MS}ms; abandoning it.`)
      );
    }, QUERY_TIMEOUT_MS);
  });

  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * A `Date` as mysql2 writes one itself under oxmysql's default `timezone: 'local'`:
 * `YYYY-MM-DD HH:MM:SS.mmm` in this process's local time. Null for an invalid date, which no
 * column can hold.
 */
export const sqlDateTime = (date: Date): string | null =>
  Number.isNaN(date.getTime())
    ? null
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
      pad(date.getMilliseconds(), 3);

/**
 * Bound values as they must be to survive the trip to oxmysql (MICA-302).
 *
 * Every call here crosses a resource boundary, and FiveM carries the arguments in msgpack with no
 * extension for a `Date` (`createCodec({ preset: false })` in the runtime's `main.js`): a `Date`
 * arrives in oxmysql as `{}`, and mysql2 writes that as `'[object Object]'`. Found by running
 * `micaimport qb-phone --apply` against real oxmysql across that codec — every imported message
 * and photo was refused with "Incorrect datetime value: '[object Object]'", rolled back, and
 * reported skipped. test:schema calls mysql2 in-process, where the `Date` survives, so it never
 * saw it. Converted here, once, so no caller has to know the boundary exists; the string is the
 * one mysql2 would have written from the `Date`, so in-process and in-game agree.
 */
export const crossable = <P>(params: P): P =>
  (Array.isArray(params)
    ? params.map((value: unknown) => (value instanceof Date ? sqlDateTime(value) : value))
    : params) as P;

export class Database {
  private static get oxmysql() {
    return (globalThis as any).exports?.oxmysql ?? (exports as any)?.oxmysql;
  }

  static async query<T = any>(query: string, params: any[] = []): Promise<T> {
    return await withTimeout<T>('query', Database.oxmysql.query_async(query, crossable(params)));
  }

  static async insert(query: string, params: any[] = []): Promise<number> {
    return await withTimeout<number>(
      'insert',
      Database.oxmysql.insert_async(query, crossable(params))
    );
  }

  static async update(query: string, params: any[] = []): Promise<boolean> {
    const result = await withTimeout<number>(
      'update',
      Database.oxmysql.update_async(query, crossable(params))
    );
    return result > 0;
  }

  static async scalar<T = any>(query: string, params: any[] = []): Promise<T> {
    return await withTimeout<T>('scalar', Database.oxmysql.scalar_async(query, crossable(params)));
  }

  static async single<T = any>(query: string, params: any[] = []): Promise<T> {
    return await withTimeout<T>('single', Database.oxmysql.single_async(query, crossable(params)));
  }

  static async transaction(queries: TransactionQuery[]): Promise<boolean> {
    if (!queries || queries.length === 0) return true;
    const formatted = queries.map(({ query, params }) => ({
      query,
      values: crossable(params ?? [])
    }));
    const result = await withTimeout<unknown>(
      'transaction',
      Database.oxmysql.transaction_async(formatted)
    );
    return Boolean(result);
  }
}
