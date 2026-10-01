// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crossable, Database, sqlDateTime } from '../lib/Database';

/**
 * MICA-160. `oxmysql` rejects correctly once a query reaches a connection and fails, but a
 * query issued before the pool has a connection at all never invokes its callback — the
 * returned promise neither resolves nor rejects. Nothing upstream ever timed out, so an
 * `await Database.query(...)` could hang forever: silent at startup, since a hung boot-time
 * await never runs the code after it, never logs, and never reports.
 *
 * These mutate the shared `exports.oxmysql` stub `setup.ts` installs, rather than mocking
 * `../lib/Database` the way every other suite does — this file is testing `Database` itself.
 */
describe('Database — an unanswered call times out rather than hanging', () => {
  const oxmysql = (globalThis as any).exports.oxmysql;
  const original = { ...oxmysql };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(oxmysql, original);
  });

  /** A promise exactly like the one a dropped export callback leaves behind. */
  const hangs = () => new Promise<never>(() => {});

  it('rejects a query that never settles, instead of hanging the caller forever', async () => {
    oxmysql.query_async = vi.fn(() => hangs());

    const result = Database.query('SELECT 1', []);
    const assertion = expect(result).rejects.toThrow(/did not answer within/);

    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('does not fire early, so an ordinary slow query still lands', async () => {
    let resolve!: (value: unknown) => void;
    oxmysql.query_async = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );

    const result = Database.query('SELECT 1', []);

    await vi.advanceTimersByTimeAsync(59_000);
    resolve([{ ok: 1 }]);

    await expect(result).resolves.toEqual([{ ok: 1 }]);
  });

  it('resolves immediately for an ordinary call, with no lingering timer effect', async () => {
    oxmysql.insert_async = vi.fn(async () => 42);

    await expect(Database.insert('INSERT ...', [])).resolves.toBe(42);
  });

  it('times out `insert`, `update`, `scalar`, `single` and `transaction` the same way', async () => {
    oxmysql.insert_async = vi.fn(() => hangs());
    oxmysql.update_async = vi.fn(() => hangs());
    oxmysql.scalar_async = vi.fn(() => hangs());
    oxmysql.single_async = vi.fn(() => hangs());
    oxmysql.transaction_async = vi.fn(() => hangs());

    const calls = [
      expect(Database.insert('x', [])).rejects.toThrow(/did not answer within/),
      expect(Database.update('x', [])).rejects.toThrow(/did not answer within/),
      expect(Database.scalar('x', [])).rejects.toThrow(/did not answer within/),
      expect(Database.single('x', [])).rejects.toThrow(/did not answer within/),
      expect(Database.transaction([{ query: 'x' }])).rejects.toThrow(/did not answer within/)
    ];

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
  });

  it('does not reject twice or throw into the timer when a hung call answers after the timeout', async () => {
    // The real oxmysql call is not cancellable — only waiting on it is abandoned. A late,
    // real answer arriving after the timeout already told the caller it failed must not
    // surface as an unhandled rejection or a second settlement.
    let resolve!: (value: unknown) => void;
    oxmysql.query_async = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );

    const result = Database.query('SELECT 1', []);
    const assertion = expect(result).rejects.toThrow(/did not answer within/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(() => resolve([{ late: true }])).not.toThrow();
  });
});

/**
 * MICA-302. Every `Database` call crosses into oxmysql through FiveM's msgpack, which has no
 * extension for a `Date` (`createCodec({ preset: false })`): one arrives as `{}` and mysql2 writes
 * it as `'[object Object]'`. Run against real oxmysql across that codec, `micaimport --apply`
 * had every message and photo refused. A `Date` must leave here as the string mysql2 itself
 * would have written from it, so the in-process path test:schema uses and the game agree.
 */
describe('Database — a Date crosses to oxmysql as the string mysql2 would write', () => {
  const oxmysql = (globalThis as any).exports.oxmysql;
  const original = { ...oxmysql };

  afterEach(() => {
    Object.assign(oxmysql, original);
  });

  const at = new Date(2026, 8, 30, 7, 5, 3, 9);

  it("formats exactly as mysql2 does under oxmysql's default local timezone", async () => {
    const { format } = await import('mysql2');
    expect(`'${sqlDateTime(at)}'`).toBe(format('?', [at]));
    expect(sqlDateTime(new Date(Number.NaN))).toBeNull();
  });

  it('converts every Date in every call, and leaves every other value alone', async () => {
    const seen: unknown[][] = [];
    const record = (_sql: string, params: unknown[]) => {
      seen.push(params);
      return Promise.resolve([]);
    };
    oxmysql.query_async = vi.fn(record);
    oxmysql.insert_async = vi.fn((sql: string, params: unknown[]) =>
      record(sql, params).then(() => 1)
    );
    oxmysql.update_async = vi.fn((sql: string, params: unknown[]) =>
      record(sql, params).then(() => 1)
    );
    oxmysql.scalar_async = vi.fn(record);
    oxmysql.single_async = vi.fn(record);
    oxmysql.transaction_async = vi.fn((queries: { values: unknown[] }[]) => {
      for (const q of queries) seen.push(q.values);
      return Promise.resolve(true);
    });

    const params = [at, 'text', 7, null, true];
    await Database.query('q', params);
    await Database.insert('i', params);
    await Database.update('u', params);
    await Database.scalar('s', params);
    await Database.single('o', params);
    await Database.transaction([{ query: 't', params }, { query: 'SET @x = 1' }]);

    const expected = [sqlDateTime(at), 'text', 7, null, true];
    expect(seen).toEqual([expected, expected, expected, expected, expected, expected, []]);
    expect(seen.flat().some((value) => value instanceof Date)).toBe(false);
    // The caller's own array is not rewritten in place.
    expect(params[0]).toBe(at);
  });

  it('passes a non-array through untouched', () => {
    expect(crossable(undefined)).toBeUndefined();
    expect(crossable({ a: 1 })).toEqual({ a: 1 });
  });
});
