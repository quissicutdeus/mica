// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The integration runner (MICA-302): scenarios one after another, each under its own timeout,
 * and the protocol lines the release harness reads off the server console.
 *
 * Pure on purpose — no FiveM global is touched here — so `integrationRunner.test.ts` can hold
 * the protocol to its exact shape without a server. The harness fails a run on any FAIL line
 * and on a missing done line, so the one property this file exists for is that the done line
 * is printed whatever a scenario does: throws, rejects, hangs, or runs past the suite's budget.
 */

/** Set once a scenario's time is up. A scenario's waits read it and stop rather than run on. */
export interface RunSignal {
  readonly aborted: boolean;
}

/**
 * The two runs the box makes of one zip (MICA-304). `standalone` is micaOS with no framework and
 * no inventory; `qbx` is micaOS beside qbx_core and ox_inventory. A scenario belongs to exactly
 * one: what it arranges and asserts is true of that stack and not the other.
 */
export type Mode = 'standalone' | 'qbx';

export const MODES: readonly Mode[] = ['standalone', 'qbx'];

export interface Scenario {
  /** What it proves, in lower-kebab-case. Printed as is, so it never contains a space. */
  id: string;
  /**
   * The run it belongs to. Written on the line after `id:`, which is how `pack-integration.js`
   * reads it without importing TypeScript. In the other run it is not silently absent: the
   * runner prints a SKIP line for it, and the box's wrapper holds the SKIP lines to the list the
   * zip was packed with.
   */
  mode: Mode;
  /** The tickets this scenario is evidence for. */
  tickets: readonly string[];
  /** Its own limit, when the default is wrong for it. Never more than the budget left. */
  timeoutMs?: number;
  run: (signal: RunSignal) => Promise<void>;
}

export interface RunnerOptions {
  print: (line: string) => void;
  /** Which of the box's two runs this is. A scenario of the other mode is skipped, loudly. */
  mode: Mode;
  /** Per scenario, unless it names its own. */
  defaultTimeoutMs: number;
  /**
   * The whole suite's time. A scenario that would start after it is failed without running,
   * so the done line lands inside the harness's window however many scenarios hung first.
   */
  budgetMs: number;
  now?: () => number;
}

export interface RunResult {
  passed: number;
  failed: number;
  /** Scenarios of the other mode. Not in the done line: the wrapper counts SKIP lines itself. */
  skipped: number;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** One line, whatever the reason held: the harness reads the console a line at a time. */
const REASON_MAX = 400;

export const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'no reason given';
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1)}…` : flat;
};

export const passLine = (id: string): string => `integration: PASS ${id}`;

/**
 * A scenario that is not this run's. Printed for every one, so the console says what was not
 * run and the wrapper can hold the list to the zip's: a scenario that vanished from a run
 * (dropped from the index, or never registered for its mode) is then a mismatch, not a
 * smaller count that looks the same.
 */
export const skipLine = (id: string, mode: Mode, own: Mode): string =>
  `integration: SKIP ${id}: needs a ${own} run, and this is the ${mode} run`;

export const failLine = (id: string, reason: string): string =>
  `integration: FAIL ${id}: ${oneLine(reason)}`;

export const doneLine = (passed: number, failed: number): string =>
  `integration: done ${passed} passed ${failed} failed`;

export const reasonOf = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

class TimedOut extends Error {}

/**
 * Run `scenario` with `limitMs` to do it in. Resolves with null on a pass and the reason on a
 * fail; never rejects. A scenario still running at its limit is left to finish on its own —
 * nothing can cancel a promise — with its signal set so its waits give up. Its eventual
 * rejection is not reported as unhandled: the race below has already subscribed to it.
 */
const runOne = async (scenario: Scenario, limitMs: number): Promise<string | null> => {
  const signal = { aborted: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      signal.aborted = true;
      reject(new TimedOut(`timed out after ${limitMs} ms`));
    }, limitMs);
  });

  let running: Promise<void>;
  try {
    running = Promise.resolve(scenario.run(signal));
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    return reasonOf(error);
  }

  try {
    await Promise.race([running, timeout]);
    return null;
  } catch (error) {
    return error instanceof TimedOut ? error.message : reasonOf(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Every scenario, in the order given, each line printed as it finishes, and the done line last.
 * Never rejects: a throw from `print` itself is the only thing that could stop it, and that is
 * the console, which is not this file's to guard.
 */
export const runScenarios = async (
  scenarios: readonly Scenario[],
  options: RunnerOptions
): Promise<RunResult> => {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const seen = new Set<string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    const id = String(scenario.id);
    if (!ID.test(id)) {
      options.print(failLine(id.replace(/\s+/g, '_') || 'unnamed', 'not a lower-kebab-case id'));
      failed += 1;
      continue;
    }
    if (seen.has(id)) {
      options.print(failLine(id, 'a second scenario has this id; not run'));
      failed += 1;
      continue;
    }
    seen.add(id);

    if (scenario.mode !== options.mode) {
      if (!MODES.includes(scenario.mode)) {
        options.print(failLine(id, `has mode '${String(scenario.mode)}', which is not a mode`));
        failed += 1;
        continue;
      }
      options.print(skipLine(id, options.mode, scenario.mode));
      skipped += 1;
      continue;
    }

    const left = deadline - now();
    if (left <= 0) {
      options.print(failLine(id, `not run: the suite's ${options.budgetMs} ms budget is spent`));
      failed += 1;
      continue;
    }

    const limit = Math.min(scenario.timeoutMs ?? options.defaultTimeoutMs, left);
    const reason = await runOne(scenario, limit);
    if (reason === null) {
      options.print(passLine(id));
      passed += 1;
    } else {
      options.print(failLine(id, reason));
      failed += 1;
    }
  }

  options.print(doneLine(passed, failed));
  return { passed, failed, skipped };
};
