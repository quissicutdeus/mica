// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { sleep } from '../lib/wait';

/**
 * The premise `micaimport --apply` stands on (MICA-233): oxmysql's `transaction_async`, called
 * across the export boundary on an idle server, answers. The importer is the only micaOS code
 * that writes through a transaction, and the first hoth run (MICA-302) saw its dry run report
 * at once — reads only — and its apply say nothing for 30 s. This asks the same question of
 * oxmysql directly, in the importer's shape (a session variable set and read in one batch), so
 * a hang here says "the transaction never answered" rather than "the importer misbehaved".
 *
 * If it does not answer, it is asked once more after an ordinary `query_async`, which is the
 * one call that schedules oxmysql a resource tick; the reason says which happened, so the next
 * run tells a stuck transaction from one that only waits for the server to tick oxmysql.
 */
const FIRST_WAIT_MS = 10_000;
const NUDGED_WAIT_MS = 10_000;

const settle = (promise: Promise<unknown>) => {
  const state: { done: boolean; value?: unknown; error?: string; at?: number } = { done: false };
  promise.then(
    (value) => Object.assign(state, { done: true, value, at: Date.now() }),
    (error: unknown) =>
      Object.assign(state, {
        done: true,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now()
      })
  );
  return state;
};

const until = async (state: { done: boolean }, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!state.done && Date.now() < deadline) await sleep(50);
};

export const oxmysqlScenarios: Scenario[] = [
  {
    id: 'oxmysql-transaction-async-answers-on-an-idle-server',
    tickets: ['MICA-233'],
    timeoutMs: FIRST_WAIT_MS + NUDGED_WAIT_MS + 10_000,
    run: async () => {
      const ox = (exports as unknown as Record<string, Record<string, Function>>).oxmysql;
      if (typeof ox?.transaction_async !== 'function') {
        throw new Error('oxmysql exports no transaction_async');
      }
      const started = Date.now();
      const state = settle(
        Promise.resolve(
          ox.transaction_async([
            { query: 'SET @mica_it_probe = 41', values: [] },
            { query: 'SELECT @mica_it_probe + 1 AS `n`', values: [] }
          ])
        )
      );
      let report: string;
      await until(state, FIRST_WAIT_MS);
      if (state.done) {
        report = `answered ${JSON.stringify(state.error ?? state.value)} in ${(state.at as number) - started} ms`;
      } else {
        const nudged = Date.now();
        await db.count('SELECT 1');
        await until(state, NUDGED_WAIT_MS);
        report = state.done
          ? `no answer in ${FIRST_WAIT_MS} ms; answered ${JSON.stringify(state.error ?? state.value)} ` +
            `${(state.at as number) - nudged} ms after a query_async`
          : `no answer in ${FIRST_WAIT_MS} ms, nor ${NUDGED_WAIT_MS} ms after a query_async`;
      }
      console.log(`[mica-integration] oxmysql transaction_async: ${report}`);
      if (!state.done || (state.at as number) - started > FIRST_WAIT_MS) {
        throw new Error(`transaction_async ${report}`);
      }
      if (state.error !== undefined || state.value !== true) {
        throw new Error(`transaction_async ${report}, not true`);
      }
    }
  }
];
