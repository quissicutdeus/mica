// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleTap } from './console';
import { runCommand } from './mica';
import { eventually, sleep, type Signal } from './wait';

/**
 * `micamedia prune`, run until micaOS accepts it.
 *
 * micaOS starts a retention pass of its own at resource start (`startRetentionSchedule`,
 * `server/lib/contentRetention.ts`), walking every registered table in turn, `mica_media`
 * among them, and again every six hours. While that pass is on `mica_media`,
 * `isRetentionRunning` is true and `micamedia prune` refuses by design rather than overlap it,
 * printing `BUSY` and running nothing. A scenario that prunes soon after boot can land in that
 * window: the qbx run on hoth did (MICA-322, run 37707937593), where earlier runs had not.
 *
 * The integration resource cannot read `isRetentionRunning`, so the command is its own probe:
 * a refusal is "not yet", and it is asked again until it runs or the deadline passes. A refused
 * attempt runs nothing, so a scenario's assertions about what the prune did are about the one
 * run that was accepted.
 */

const SUMMARY =
  /^\[micamedia\] (prune finished: |a retention prune of mica_media is already running)/;

/** The refusal's words, as `runMediaPruneCommand` prints them. */
export const BUSY = 'a retention prune of mica_media is already running';

/**
 * How long after a refusal to ask again. One line per attempt reaches the console, so asking
 * at `eventually`'s own cadence would print one every 200 ms for as long as the pass runs.
 */
const RETRY_AFTER_MS = 1_000;

/**
 * Run `micamedia prune` until it is accepted, and answer its `prune finished:` line.
 *
 * Fails, naming why, when it never is: still refused at the deadline (with how many times and
 * the last refusal), or an attempt that printed neither line (`ConsoleTap.waitFor`'s error,
 * which carries what micaOS did say).
 */
export const runMediaPrune = async (
  tap: ConsoleTap,
  timeoutMs: number,
  signal: Signal
): Promise<string> => {
  const what = 'micamedia prune that micaOS accepted';
  const deadline = Date.now() + timeoutMs;
  let refused = 0;
  let last = '';
  try {
    return await eventually(
      async () => {
        const mark = tap.mark();
        await runCommand('micamedia prune');
        const line = await tap.waitFor(
          mark,
          SUMMARY,
          Math.max(1_000, deadline - Date.now()),
          signal,
          "micamedia prune's summary"
        );
        if (!line.includes(BUSY)) return line;
        refused += 1;
        last = line;
        if (Date.now() + RETRY_AFTER_MS < deadline) await sleep(RETRY_AFTER_MS);
        return null;
      },
      timeoutMs,
      signal,
      what
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (refused > 0 && message === `no ${what} within ${timeoutMs} ms`) {
      throw new Error(
        `micamedia prune never ran: refused ${refused} time(s) in ${timeoutMs} ms because a ` +
          `retention prune of mica_media was still running (micaOS's own pass, at start or on ` +
          `its six-hourly schedule). Last said: ${last}`,
        { cause: error }
      );
    }
    throw error;
  }
};
