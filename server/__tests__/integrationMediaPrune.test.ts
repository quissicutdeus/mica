// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleTap } from '../../integration/lib/console';
import { bootOrphanSweepEnded } from '../../integration/lib/bootSweep';
import { BUSY, runMediaPrune } from '../../integration/lib/mediaPrune';

/**
 * MICA-322's follow-up, two waits the qbx orphan-sweep scenario stands on. `runMediaPrune` asks
 * `micamedia prune` again while micaOS's own retention pass holds mica_media, and fails naming
 * why when it never runs; the command is stubbed as a console that answers each
 * `ExecuteCommand` with the next scripted line. `bootOrphanSweepEnded` waits for the start-up
 * orphan sweep's last line, and fails naming whether it started at all.
 */
const never = { aborted: false };
const FINISHED = '[micamedia] prune finished: 0 expired row(s), 2 orphaned row(s) removed.';
const REFUSED = `[micamedia] ${BUSY}; run micamedia prune again when it has finished.`;

const scripted = (answers: (string | null)[]) => {
  const tap = new ConsoleTap('script:mica-integration');
  let asked = 0;
  (globalThis as any).ExecuteCommand = () => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (answer !== null) tap.push('script:mica', answer);
  };
  return { tap, asked: () => asked };
};

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).ExecuteCommand;
});

describe('runMediaPrune', () => {
  it('answers the first run micaOS accepts', async () => {
    const { tap, asked } = scripted([FINISHED]);
    expect(await runMediaPrune(tap, 5_000, never)).toBe(FINISHED);
    expect(asked()).toBe(1);
  });

  it('asks again while a retention pass holds mica_media, then answers the accepted run', async () => {
    vi.useFakeTimers();
    const { tap, asked } = scripted([REFUSED, REFUSED, FINISHED]);
    const done = runMediaPrune(tap, 30_000, never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe(FINISHED);
    expect(asked()).toBe(3);
  });

  it('fails naming the refusals when the prune never gets to run', async () => {
    vi.useFakeTimers();
    const { tap, asked } = scripted([REFUSED]);
    const done = runMediaPrune(tap, 5_000, never);
    const verdict = expect(done).rejects.toThrow(
      /^micamedia prune never ran: refused \d+ time\(s\) in 5000 ms because a retention prune of mica_media was still running/
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await verdict;
    expect(asked()).toBeGreaterThan(1);
  });

  it('fails as the tap does when an attempt prints neither line', async () => {
    vi.useFakeTimers();
    const { tap } = scripted([null]);
    const done = runMediaPrune(tap, 2_000, never);
    const verdict = expect(done).rejects.toThrow(/^no micamedia prune's summary within/);
    await vi.advanceTimersByTimeAsync(5_000);
    await verdict;
  });
});

describe('bootOrphanSweepEnded', () => {
  const STARTING = '[mica] orphan sweep starting over 22 table(s).';
  const SWEEP_FINISHED = '[mica] orphan sweep finished: removed 0 row(s).';

  it('answers at once when the sweep has already finished', async () => {
    const tap = new ConsoleTap('script:mica-integration');
    tap.push('script:mica', STARTING);
    tap.push('script:mica', SWEEP_FINISHED);
    expect(await bootOrphanSweepEnded(tap, 1_000, never)).toBe(SWEEP_FINISHED);
  });

  it('waits for a sweep that is still running to finish, or to fail', async () => {
    vi.useFakeTimers();
    for (const last of [SWEEP_FINISHED, '[mica] orphan sweep failed: Error: lost connection']) {
      const tap = new ConsoleTap('script:mica-integration');
      tap.push('script:mica', STARTING);
      let settled = false;
      const done = bootOrphanSweepEnded(tap, 10_000, never).then((line) => {
        settled = true;
        return line;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      tap.push('script:mica', last);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await done).toBe(last);
    }
  });

  it('fails naming a sweep that started and never finished', async () => {
    vi.useFakeTimers();
    const tap = new ConsoleTap('script:mica-integration');
    tap.push('script:mica', STARTING);
    const verdict = expect(bootOrphanSweepEnded(tap, 2_000, never)).rejects.toThrow(
      /said it was starting and had not finished within 2000 ms/
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await verdict;
  });

  it('fails naming that neither line was seen, rather than going ahead blind', async () => {
    vi.useFakeTimers();
    const tap = new ConsoleTap('script:mica-integration');
    // A line on the per-table failure count is not the sweep's end.
    tap.push('script:mica', '[mica] orphan sweep failed on 1 table(s): mica_notes');
    const verdict = expect(bootOrphanSweepEnded(tap, 2_000, never)).rejects.toThrow(
      /neither "\[mica\] orphan sweep starting" nor its finished line reached/
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await verdict;
  });
});
