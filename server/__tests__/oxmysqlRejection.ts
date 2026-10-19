// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { runInNewContext } from 'node:vm';

/**
 * A failed write as it reaches this resource in game.
 *
 * oxmysql's `*_async` export rejects with `new Error(output)` (its `src/index.ts`), where
 * `output` is "<resource> was unable to execute a query!", the query, the parameters, and
 * mysql2's own message on the last line — no `errno`, no `code`. And it is built in **oxmysql's**
 * resource, so it is not this realm's `Error`: `instanceof Error` is false on it here.
 *
 * Built in a fresh `vm` context for that reason. A duplicate-key check written
 * `error instanceof Error ? error.message : ''` reads every real duplicate as an empty message
 * and rethrows it, so a second identical reaction answered the generic error in a real server
 * (the in-server suite, run 39242728050) while every suite rejecting with this realm's
 * `new Error('Duplicate entry …')` passed. A suite proving a duplicate is classified the way the
 * game will see it rejects with this.
 *
 * Not a test file itself; it lives beside `phoneStub.ts` and `queryCounter.ts` because
 * `server/tsconfig.json` excludes this directory, so shipping code cannot import it.
 */
export const oxmysqlRejection = (sql: string, params: unknown[], driverMessage: string): unknown =>
  runInNewContext('new Error(text)', {
    text:
      `mica was unable to execute a query!\nQuery: ${sql}\n` +
      `${JSON.stringify(params)}\n${driverMessage}`
  });

/** mysql2's message for ER 1062, as the last line of an `oxmysqlRejection`. */
export const duplicateEntry = (entry: string, key: string): string =>
  `Duplicate entry '${entry}' for key '${key}'`;
