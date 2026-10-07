// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import mysql from 'mysql2/promise';

/**
 * oxmysql's `*_async` exports over one mysql2 connection, for `test-endpoints.js` (MICA-304).
 *
 * Faithful where the code under test can tell the difference, each point read from oxmysql's
 * own source (`vendor/oxmysql/src`), not remembered:
 *
 * - **The pool's `typeCast`** (`utils/typeCast.ts`, the mysql-async compatible one): DATETIME
 *   and TIMESTAMP arrive as epoch milliseconds, DATE likewise at local midnight, `TINYINT(1)`
 *   and `BIT(1)` as booleans, a binary BLOB as an array of bytes. A shim handing back mysql2's
 *   own `Date` objects would prove a path no server takes.
 * - **The pool's options** (`config.ts`): `supportBigNumbers` and `jsonStrings`, and no
 *   `multipleStatements` — one statement per call, as oxmysql's pool hands out.
 * - **`parseArguments`** (`utils/parseArguments.ts`): too few parameters are padded with
 *   null, too many is a refusal.
 * - **`parseResponse`** (`utils/parseResponse.ts`): what each of insert, update, single and
 *   scalar answers, null included.
 * - **A failure rejects with text only** (`logger/index.ts`): "<resource> was unable to execute
 *   a query!", the query, the parameters and the driver's message last, with no `errno` and no
 *   `code` (server agent memory, `oxmysql-errors-carry-no-errno.md`).
 * - **A transaction** answers `true`, or `false` after a rollback, and never throws.
 *
 * Not faithful: oxmysql runs on a pool, so two statements can be in flight at once; this runs
 * them one after another on one connection. A race between two players' writes that only a
 * pool can produce is not exercised here.
 */

const BINARY_CHARSET = 63;

/** oxmysql `src/utils/typeCast.ts`, `typeCast`: the pool's, which `query` and friends use. */
const typeCast = (field, next) => {
  switch (field.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE': {
      const value = field.string();
      return value ? new Date(value).getTime() : null;
    }
    case 'DATE': {
      const value = field.string();
      return value ? new Date(value + ' 00:00:00').getTime() : null;
    }
    case 'TINY': {
      if (field.length !== 1) return next();
      const value = field.string();
      return value === '0' ? false : value === '1' ? true : next();
    }
    case 'BIT': {
      const buffer = field.buffer();
      if (!buffer || buffer.length !== 1) return next();
      const value = buffer[0];
      return value === 0 ? false : value === 1 ? true : next();
    }
    case 'TINY_BLOB':
    case 'MEDIUM_BLOB':
    case 'LONG_BLOB':
    case 'BLOB':
      if (field.charset === BINARY_CHARSET) {
        const value = field.buffer();
        if (value === null) return [value];
        return [...value];
      }
      return field.string();
    default:
      return next();
  }
};

/** One connection configured as oxmysql's pool configures each of its own. */
export const connectAsOxmysql = (config, database) =>
  mysql.createConnection({
    ...config,
    database,
    supportBigNumbers: true,
    jsonStrings: true,
    typeCast,
    multipleStatements: false
  });

/** oxmysql `src/utils/parseArguments.ts`, for an array of positional parameters. */
const parseArguments = (query, parameters) => {
  if (typeof query !== 'string') {
    throw new Error(`Expected query to be a string but received ${typeof query} instead.`);
  }
  let params = !parameters || typeof parameters === 'function' ? [] : parameters;
  if (!Array.isArray(params)) {
    throw new Error('the harness only passes positional parameters; got an object');
  }
  const placeholders = query.match(/\?(?!\?)/g)?.length ?? 0;
  if (placeholders) {
    const diff = placeholders - params.length;
    if (diff > 0) params = [...params, ...Array.from({ length: diff }, () => null)];
    else if (diff < 0) {
      throw new Error(`Expected ${placeholders} parameters, but received ${params.length}.`);
    }
  }
  return [query, params];
};

/** oxmysql `src/utils/parseResponse.ts`. */
const parseResponse = (type, result) => {
  switch (type) {
    case 'insert':
      return result?.insertId ?? null;
    case 'update':
      return result?.affectedRows ?? null;
    case 'single':
      return result?.[0] ?? null;
    case 'scalar': {
      const row = result?.[0];
      return (row && Object.values(row)[0]) ?? null;
    }
    default:
      return result ?? null;
  }
};

/**
 * The export table, and two things the harness needs to know about it: whether anything is
 * still running (`idle`), so a step can wait for a handler's fire-and-forget writes to land,
 * and how many statements ran.
 */
export const createOxmysql = (connection, { resource = 'mica' } = {}) => {
  let tail = Promise.resolve();
  let inflight = 0;
  let statements = 0;

  const serial = (work) => {
    inflight += 1;
    const run = tail.then(work, work).finally(() => {
      inflight -= 1;
    });
    tail = run.catch(() => {});
    return run;
  };

  const failure = (query, params, error) =>
    new Error(
      `${resource} was unable to execute a query!` +
        (query ? `\nQuery: ${query}` : '') +
        (params ? `\n${JSON.stringify(params)}` : '') +
        `\n${error?.message ?? error}`
    );

  const run = (type) => (query, parameters) =>
    serial(async () => {
      let parsed;
      try {
        parsed = parseArguments(query, parameters);
      } catch (error) {
        throw failure(undefined, undefined, error);
      }
      const [sql, params] = parsed;
      statements += 1;
      try {
        const [result] = await connection.query(sql, params);
        return parseResponse(type, result);
      } catch (error) {
        throw failure(sql, params, error);
      }
    });

  const oxmysql = {
    query_async: run(null),
    insert_async: run('insert'),
    update_async: run('update'),
    scalar_async: run('scalar'),
    single_async: run('single'),
    transaction_async: (queries) =>
      serial(async () => {
        if (!Array.isArray(queries)) return false;
        await connection.query('START TRANSACTION');
        try {
          for (const entry of queries) {
            const [sql, params] = parseArguments(entry.query, entry.parameters ?? entry.values);
            statements += 1;
            await connection.query(sql, params);
          }
          await connection.query('COMMIT');
          return true;
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => {});
          console.error(`${resource} was unable to complete a transaction!\n${error.message}`);
          return false;
        }
      })
  };

  return {
    oxmysql,
    idle: () => inflight === 0,
    statements: () => statements
  };
};
