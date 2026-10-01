// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * oxmysql, straight: how a scenario arranges its fixtures and reads what micaOS wrote. Never a
 * path micaOS's behaviour is proven *through* — every assertion's subject is an export, a
 * command or an event, and this is only the ground truth it is checked against.
 *
 * Timestamps are read as `UNIX_TIMESTAMP(...)` in the SQL rather than as oxmysql's own date
 * conversion, so a comparison never depends on how a driver renders a date.
 */
type Row = Record<string, unknown>;

const QUERY_TIMEOUT_MS = 20_000;

const oxmysql = (): Record<string, (sql: string, params: unknown[]) => Promise<unknown>> => {
  const found = (exports as unknown as Record<string, unknown>).oxmysql;
  if (!found) throw new Error('oxmysql is not available to this resource');
  return found as Record<string, (sql: string, params: unknown[]) => Promise<unknown>>;
};

const call = async <T>(method: string, sql: string, params: unknown[]): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`oxmysql ${method} did not answer within ${QUERY_TIMEOUT_MS} ms`)),
      QUERY_TIMEOUT_MS
    );
  });
  try {
    return (await Promise.race([oxmysql()[method](sql, params), timeout])) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQL failed (${sql.replace(/\s+/g, ' ').slice(0, 80)}…): ${message}`, {
      cause: error
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const db = {
  async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await call<unknown>('query_async', sql, params);
    return Array.isArray(result) ? (result as Row[]) : [];
  },

  async row(sql: string, params: unknown[] = []): Promise<Row | null> {
    const found = await db.rows(sql, params);
    return found[0] ?? null;
  },

  /** The first column of the first row, as a number; 0 when there is none. */
  async count(sql: string, params: unknown[] = []): Promise<number> {
    const value = await call<unknown>('scalar_async', sql, params);
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  },

  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const id = Number(await call<unknown>('insert_async', sql, params));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`an insert returned id ${id}`);
    return id;
  },

  /** Anything that is not a read: DDL, an update, a delete. */
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await call<unknown>('query_async', sql, params);
  }
};
