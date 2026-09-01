// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { vi, type Mock } from 'vitest';

/**
 * A `Database` mock that remembers what it was asked, so a suite can assert on the **number**
 * of statements an action issues rather than only on their text.
 *
 * Every other suite here mocks `Database` to control what comes back. None of them could say
 * how many times it was reached, and that is the thing MICA-197 was about: the conversation
 * list issued one query per thread and a send issued two lookups per recipient, and each of
 * those queries was individually correct. A suite asserting SQL text passes on a 1+N read
 * exactly as it passes on a batched one, which is why both survived so long.
 *
 * Not a test file itself, and it deliberately lives here rather than in `server/lib/`: it is
 * test scaffolding, and `server/tsconfig.json` excludes this directory so nothing in it can
 * be imported by shipping code by accident.
 *
 * **It must never reach a real connection.** It does not import `../lib/Database` at all —
 * that module reads `exports.oxmysql` in module scope — and every method here is a `vi.fn`
 * answering from what a test queued.
 */

/** The `Database` surface the resource actually uses. */
export type DatabaseMethod = 'query' | 'single' | 'scalar' | 'insert' | 'update';

export interface RecordedStatement {
  method: DatabaseMethod;
  /** Whitespace collapsed, so a multi-line template matches a readable pattern. */
  sql: string;
  params: unknown[];
}

export interface CountingDatabase {
  query: Mock;
  single: Mock;
  scalar: Mock;
  insert: Mock;
  update: Mock;

  /** Every statement issued since the last `reset`, in order. */
  readonly statements: RecordedStatement[];

  /**
   * How many statements were issued — all of them, or only those whose SQL matches.
   *
   * A pattern is what makes a budget legible: "one statement mentioning
   * `gphone_messages_participants`" says what is being counted, where a bare total also
   * counts whatever the endpoint wrapper happens to do around it.
   */
  count(pattern?: RegExp): number;

  /** Queue answers for successive `query` calls. Anything unqueued answers with `[]`. */
  answerQuery(...results: unknown[][]): void;

  /** Queue answers for successive `single` calls. Anything unqueued answers with `null`. */
  answerSingle(...results: unknown[]): void;

  /** Forget everything recorded and everything queued. */
  reset(): void;
}

const collapse = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();

/**
 * A fresh counting `Database`.
 *
 * Built by a factory rather than exported as a singleton so two suites in one run cannot
 * share a statement log — Vitest isolates modules per file, but a helper that only works
 * because of that is a helper that breaks the day somebody turns isolation off.
 */
export function createCountingDatabase(): CountingDatabase {
  const statements: RecordedStatement[] = [];
  const queryQueue: unknown[][] = [];
  const singleQueue: unknown[] = [];

  const record = (method: DatabaseMethod, sql: unknown, params: unknown): void => {
    statements.push({
      method,
      sql: collapse(sql),
      params: Array.isArray(params) ? [...params] : []
    });
  };

  const db: CountingDatabase = {
    query: vi.fn(async (sql: unknown, params: unknown) => {
      record('query', sql, params);
      return queryQueue.length > 0 ? queryQueue.shift() : [];
    }),
    single: vi.fn(async (sql: unknown, params: unknown) => {
      record('single', sql, params);
      return singleQueue.length > 0 ? singleQueue.shift() : null;
    }),
    scalar: vi.fn(async (sql: unknown, params: unknown) => {
      record('scalar', sql, params);
      return null;
    }),
    insert: vi.fn(async (sql: unknown, params: unknown) => {
      record('insert', sql, params);
      return 1;
    }),
    update: vi.fn(async (sql: unknown, params: unknown) => {
      record('update', sql, params);
      return true;
    }),

    statements,

    count: (pattern?: RegExp) =>
      pattern ? statements.filter((s) => pattern.test(s.sql)).length : statements.length,

    answerQuery: (...results: unknown[][]) => {
      queryQueue.push(...results);
    },

    answerSingle: (...results: unknown[]) => {
      singleQueue.push(...results);
    },

    reset: () => {
      statements.length = 0;
      queryQueue.length = 0;
      singleQueue.length = 0;
    }
  };

  return db;
}
