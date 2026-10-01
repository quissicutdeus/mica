// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { consoleTap } from './lib/console';
import { db } from './lib/db';
import { micaReady } from './lib/mica';
import { sleep } from './lib/wait';
import { doneLine, failLine, runScenarios } from './runner';
import { scenarios } from './scenarios';

/**
 * `mica-integration` (MICA-302): micaOS's server behaviour, proven inside a real FXServer against
 * a real MariaDB, through the surfaces another resource or the console has — exports, console
 * commands, server events — with oxmysql to arrange fixtures and read back what landed.
 *
 * The release harness starts it after `mica` with `set mica_integration "1"` and reads the
 * protocol off the console: one `integration: PASS <id>` or `integration: FAIL <id>: <reason>`
 * per scenario, then `integration: done <P> passed <F> failed`, always.
 *
 * It writes fixture rows, creates and drops qb-phone's table names, runs `micaschema apply` and
 * `micacrypt backfill --apply`: never on a server anybody plays on. Without the convar it does
 * nothing at all, and says so once.
 */

/** How long micaOS gets to come up after this resource starts. */
const READY_TIMEOUT_MS = 60_000;

/**
 * Inside the harness's 300 s from `mica started!`, with room for the wait above: a hung scenario
 * costs the ones after it their turn, never the done line.
 */
const BUDGET_MS = 220_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const print = (line: string): void => console.log(line);

const waitForMica = async (): Promise<string | null> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastProblem = 'mica is not started';
  while (Date.now() < deadline) {
    if (await micaReady()) {
      try {
        await db.count('SELECT 1');
        return null;
      } catch (error) {
        lastProblem = `oxmysql does not answer: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      lastProblem = `mica is ${GetResourceState('mica')} and its exports do not answer`;
    }
    await sleep(500);
  }
  return `${lastProblem} after ${READY_TIMEOUT_MS} ms`;
};

const main = async (): Promise<void> => {
  // Before anything else, so no line micaOS prints during the run is missed.
  consoleTap();

  const problem = await waitForMica();
  if (problem !== null) {
    print(failLine('startup', problem));
    print(doneLine(0, 1));
    return;
  }
  // micaOS's own start-up work (the schema report, the retention and orphan passes) is
  // asynchronous; let it finish before the first scenario reads or writes beside it.
  await sleep(3_000);

  await runScenarios(scenarios, {
    print,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    budgetMs: BUDGET_MS
  });
};

on('onResourceStart', (resource: string) => {
  if (resource !== GetCurrentResourceName()) return;
  if (GetConvar('mica_integration', '') !== '1') {
    print('integration: not running; mica_integration is not "1" on this server');
    return;
  }
  void main().catch((error: unknown) => {
    // `runScenarios` never rejects; this is the tap or the wait, before any scenario ran.
    print(failLine('startup', error instanceof Error ? error.message : String(error)));
    print(doneLine(0, 1));
  });
});
