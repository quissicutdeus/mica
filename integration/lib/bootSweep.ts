// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleTap } from './console';
import { eventually, type Signal } from './wait';

/**
 * micaOS's start-up orphan sweep (`server/lib/shell.ts`, MICA-300), seen through the console.
 *
 * At resource start, once the schema is ready, micaOS deletes every row whose owner no longer
 * exists, across every owned table. A scenario that plants orphan rows of its own and then
 * asserts what *its* sweep did must not plant them while that pass is still going, or the pass
 * can take them first and the scenario sees nothing. The sweep has no state another resource
 * can read, but it says `starting` before its first query and `finished` (or `failed`) at the
 * end, whatever it found, so the console is the probe.
 *
 * Not covered, because nothing about it is observable: `Media.ts` runs a second, media-only
 * orphan sweep at start, which prints only when it removes something. It shares the boot with
 * this one and is normally done with it; that it is done cannot be shown from here.
 */

const STARTING = /^\[mica\] orphan sweep starting over \d+ table\(s\)\.$/;
/** `finished: …`, or `failed: …` when the sweep itself threw. */
const ENDED = /^\[mica\] orphan sweep (finished: |failed: )/;

/**
 * The start-up orphan sweep's last line, once it has printed one; waits up to `timeoutMs`.
 *
 * Fails, naming why, when it has not ended in time: started and still running, or never seen
 * at all. The second would mean this resource's console tap registered after micaOS printed
 * both lines (the wrapper starts `mica` first), which would make the wait impossible to
 * satisfy — loud, rather than a scenario going ahead beside a sweep it cannot see.
 */
export const bootOrphanSweepEnded = async (
  tap: ConsoleTap,
  timeoutMs: number,
  signal: Signal
): Promise<string> => {
  const what = "micaOS's start-up orphan sweep to end";
  let started = false;
  try {
    return await eventually(
      async () => {
        const lines = tap.since(0);
        const ended = lines.find((line) => ENDED.test(line));
        if (ended !== undefined) return ended;
        started = started || lines.some((line) => STARTING.test(line));
        return null;
      },
      timeoutMs,
      signal,
      what
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== `no ${what} within ${timeoutMs} ms`) throw error;
    throw new Error(
      started
        ? `micaOS's start-up orphan sweep said it was starting and had not finished within ` +
            `${timeoutMs} ms; rows planted beside it could be swept by it rather than by the ` +
            'scenario'
        : `neither "[mica] orphan sweep starting" nor its finished line reached this ` +
            `resource's console within ${timeoutMs} ms, so whether the start-up sweep is done ` +
            'cannot be told; either it never ran, or the tap registered after it printed both',
      { cause: error }
    );
  }
};
