// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleTap } from './console';
import { eventually, type Signal } from './wait';

/**
 * micaOS's two start-up orphan sweeps, seen through the console.
 *
 * At resource start, once the schema is ready, micaOS deletes rows whose owner no longer
 * exists, twice over: the whole-phone sweep across every owned table (`server/lib/shell.ts`,
 * MICA-300), and a media-only one (`server/services/Media.ts`'s start hook). A scenario that
 * plants orphan rows of its own and then asserts what *its* sweep did must not plant them while
 * either pass is still going, or the pass can take them first and the scenario sees nothing.
 * Neither sweep has state another resource can read, but each says `starting` before its first
 * query and `finished` (or `failed`) at the end, whatever it found, so the console is the probe.
 *
 * The media sweep has said so since MICA-332; before that it printed only when it removed
 * something, and that it had ended could not be shown from here. While it runs, `micamedia
 * prune` refuses rather than overlap it.
 */

/** One start-up sweep's lines, and how its waits name it. */
interface BootSweep {
  /** What a failure calls it. */
  name: string;
  /** The `starting` line, quoted in the failure that saw neither line. */
  startingText: string;
  starting: RegExp;
  /** `finished: …`, or `failed: …` when the sweep itself threw. */
  ended: RegExp;
}

const WHOLE_PHONE: BootSweep = {
  name: "micaOS's start-up orphan sweep",
  startingText: '[mica] orphan sweep starting',
  starting: /^\[mica\] orphan sweep starting over \d+ table\(s\)\.$/,
  ended: /^\[mica\] orphan sweep (finished: |failed: )/
};

/**
 * Media's. A start-up sweep skipped because `micamedia prune` already holds `mica_media`
 * prints `skipped at start`, which is not an end: the prune is still sweeping. No scenario
 * runs one before this wait, so the wait failing on it would be the loud answer it should be.
 */
const MEDIA: BootSweep = {
  name: "micaOS's start-up media orphan sweep",
  startingText: '[micamedia] orphan sweep starting',
  starting: /^\[micamedia\] orphan sweep starting over mica_media\.$/,
  ended: /^\[micamedia\] orphan sweep (finished: |failed: )/
};

/**
 * `sweep`'s last line, once it has printed one; waits up to `timeoutMs`.
 *
 * Fails, naming why, when it has not ended in time: started and still running, or never seen
 * at all. The second would mean this resource's console tap registered after micaOS printed
 * both lines (the wrapper starts `mica` first), which would make the wait impossible to
 * satisfy — loud, rather than a scenario going ahead beside a sweep it cannot see.
 */
const sweepEnded = async (
  sweep: BootSweep,
  tap: ConsoleTap,
  timeoutMs: number,
  signal: Signal
): Promise<string> => {
  const what = `${sweep.name} to end`;
  let started = false;
  try {
    return await eventually(
      async () => {
        const lines = tap.since(0);
        const ended = lines.find((line) => sweep.ended.test(line));
        if (ended !== undefined) return ended;
        started = started || lines.some((line) => sweep.starting.test(line));
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
        ? `${sweep.name} said it was starting and had not finished within ` +
            `${timeoutMs} ms; rows planted beside it could be swept by it rather than by the ` +
            'scenario'
        : `neither "${sweep.startingText}" nor its finished line reached this ` +
            `resource's console within ${timeoutMs} ms, so whether the start-up sweep is done ` +
            'cannot be told; either it never ran, or the tap registered after it printed both',
      { cause: error }
    );
  }
};

/** The whole-phone start-up orphan sweep's last line (`server/lib/shell.ts`). */
export const bootOrphanSweepEnded = async (
  tap: ConsoleTap,
  timeoutMs: number,
  signal: Signal
): Promise<string> => await sweepEnded(WHOLE_PHONE, tap, timeoutMs, signal);

/** The media-only start-up orphan sweep's last line (`server/services/Media.ts`, MICA-332). */
export const bootMediaOrphanSweepEnded = async (
  tap: ConsoleTap,
  timeoutMs: number,
  signal: Signal
): Promise<string> => await sweepEnded(MEDIA, tap, timeoutMs, signal);
