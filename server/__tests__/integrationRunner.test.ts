// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  MODES,
  doneLine,
  failLine,
  oneLine,
  passLine,
  runScenarios,
  skipLine,
  type Mode,
  type RunSignal,
  type Scenario
} from '../../integration/runner';
import { scenarios as registered } from '../../integration/scenarios';
// @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
import { scenarioIds } from '../../scripts/pack-integration.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { consoleLines, ConsoleTap } from '../../integration/lib/console';

/**
 * MICA-302: the integration runner, held to the protocol the release harness reads. The harness
 * fails a run on any FAIL line and on a missing done line, so the properties pinned here are the
 * exact line shapes, the order, and that one scenario's throw, rejection or hang never costs the
 * others their turn or the run its done line.
 */

const scenario = (
  id: string,
  run: Scenario['run'],
  timeoutMs?: number,
  mode: Mode = 'standalone'
): Scenario => ({
  id,
  mode,
  tickets: ['MICA-302'],
  run,
  ...(timeoutMs === undefined ? {} : { timeoutMs })
});

const run = async (
  scenarios: Scenario[],
  over: { budgetMs?: number; defaultTimeoutMs?: number; mode?: Mode } = {}
) => {
  const lines: string[] = [];
  const result = await runScenarios(scenarios, {
    print: (line) => lines.push(line),
    mode: over.mode ?? 'standalone',
    defaultTimeoutMs: over.defaultTimeoutMs ?? 1_000,
    budgetMs: over.budgetMs ?? 10_000
  });
  return { lines, result };
};

const never = (): Promise<void> => new Promise<void>(() => {});

describe('the protocol lines', () => {
  it('are exactly the shapes the harness greps for', () => {
    expect(passLine('schema-ok')).toBe('integration: PASS schema-ok');
    expect(failLine('schema-ok', 'missing tables: a, b')).toBe(
      'integration: FAIL schema-ok: missing tables: a, b'
    );
    expect(doneLine(3, 1)).toBe('integration: done 3 passed 1 failed');
    expect(doneLine(0, 0)).toBe('integration: done 0 passed 0 failed');
    expect(skipLine('qbx-thing', 'standalone', 'qbx')).toBe(
      'integration: SKIP qbx-thing: needs a qbx run, and this is the standalone run'
    );
  });

  it('keeps a reason on one line, says something when it is empty, and caps it', () => {
    expect(failLine('x', 'first\nsecond\r\n\tthird')).toBe(
      'integration: FAIL x: first second third'
    );
    expect(failLine('x', '   ')).toBe('integration: FAIL x: no reason given');
    const long = oneLine('y'.repeat(5_000));
    expect(long.length).toBe(400);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('runScenarios', () => {
  it('runs in the order given, one at a time, and ends with the done line', async () => {
    const order: string[] = [];
    let active = 0;
    const step = (id: string, ms: number) =>
      scenario(id, async () => {
        active += 1;
        expect(active).toBe(1);
        order.push(`start ${id}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end ${id}`);
        active -= 1;
      });
    const { lines, result } = await run([step('a', 30), step('b', 1), step('c', 10)]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(lines).toEqual([
      'integration: PASS a',
      'integration: PASS b',
      'integration: PASS c',
      'integration: done 3 passed 0 failed'
    ]);
    expect(result).toEqual({ passed: 3, failed: 0, skipped: 0 });
  });

  it('isolates a throw, a rejection and a non-Error rejection, and runs the rest', async () => {
    const { lines, result } = await run([
      scenario('sync-throw', () => {
        throw new Error('boom');
      }),
      scenario('rejects', async () => {
        throw new Error('the row is not there');
      }),
      scenario('rejects-a-string', () => Promise.reject('plain string')),
      scenario('still-runs', async () => {})
    ]);
    expect(lines).toEqual([
      'integration: FAIL sync-throw: boom',
      'integration: FAIL rejects: the row is not there',
      'integration: FAIL rejects-a-string: plain string',
      'integration: PASS still-runs',
      'integration: done 1 passed 3 failed'
    ]);
    expect(result).toEqual({ passed: 1, failed: 3, skipped: 0 });
  });

  it('fails a hung scenario at its own timeout, signals it, and moves on', async () => {
    let seen: RunSignal | null = null;
    const started = Date.now();
    const { lines } = await run([
      scenario(
        'hangs',
        (signal) => {
          seen = signal;
          return never();
        },
        50
      ),
      scenario('after', async () => {})
    ]);
    expect(Date.now() - started).toBeLessThan(900);
    expect(lines).toEqual([
      'integration: FAIL hangs: timed out after 50 ms',
      'integration: PASS after',
      'integration: done 1 passed 1 failed'
    ]);
    expect((seen as RunSignal | null)?.aborted).toBe(true);
  });

  it('uses the default timeout for a scenario that names none', async () => {
    const { lines } = await run([scenario('slow', never)], { defaultTimeoutMs: 40 });
    expect(lines[0]).toBe('integration: FAIL slow: timed out after 40 ms');
  });

  it('does not report a rejection that lands after the timeout as unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { lines } = await run([
        scenario(
          'late-reject',
          () =>
            new Promise<void>((_resolve, reject) =>
              setTimeout(() => reject(new Error('late')), 60)
            ),
          20
        )
      ]);
      expect(lines[0]).toBe('integration: FAIL late-reject: timed out after 20 ms');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('caps every scenario at the budget left, and fails the ones the budget never reaches', async () => {
    const ran: string[] = [];
    const { lines, result } = await run(
      [
        scenario('eats-the-budget', never, 10_000),
        scenario('never-reached', async () => {
          ran.push('never-reached');
        })
      ],
      { budgetMs: 60 }
    );
    expect(ran).toEqual([]);
    expect(lines[0]).toMatch(/^integration: FAIL eats-the-budget: timed out after (5\d|60) ms$/);
    expect(lines[1]).toBe(
      "integration: FAIL never-reached: not run: the suite's 60 ms budget is spent"
    );
    expect(lines[2]).toBe('integration: done 0 passed 2 failed');
    expect(result).toEqual({ passed: 0, failed: 2, skipped: 0 });
  });

  it('refuses a malformed or repeated id without running it', async () => {
    const ran: string[] = [];
    const ok = (id: string) =>
      scenario(id, async () => {
        ran.push(id);
      });
    const { lines } = await run([ok('fine'), ok('fine'), ok('Has Spaces')]);
    expect(ran).toEqual(['fine']);
    expect(lines).toEqual([
      'integration: PASS fine',
      'integration: FAIL fine: a second scenario has this id; not run',
      'integration: FAIL Has_Spaces: not a lower-kebab-case id',
      'integration: done 1 passed 2 failed'
    ]);
  });

  it('prints only the done line for an empty suite', async () => {
    const { lines } = await run([]);
    expect(lines).toEqual(['integration: done 0 passed 0 failed']);
  });
});

/**
 * MICA-304. A scenario belongs to one of the box's two runs, and in the other it is not absent: it
 * prints a SKIP line, which the wrapper holds to the list the zip was packed with. A silent skip
 * is the failure this exists to rule out.
 */
describe('the two runs', () => {
  it('skips, with a printed line and without running, a scenario of the other run', async () => {
    const ran: string[] = [];
    const mark = (id: string) => async () => {
      ran.push(id);
    };
    const mixed = [
      scenario('own', mark('own')),
      scenario('theirs', mark('theirs'), undefined, 'qbx'),
      scenario('own-too', mark('own-too'))
    ];

    const standalone = await run(mixed, { mode: 'standalone' });
    expect(standalone.lines).toEqual([
      'integration: PASS own',
      'integration: SKIP theirs: needs a qbx run, and this is the standalone run',
      'integration: PASS own-too',
      'integration: done 2 passed 0 failed'
    ]);
    expect(standalone.result).toEqual({ passed: 2, failed: 0, skipped: 1 });
    expect(ran).toEqual(['own', 'own-too']);

    ran.length = 0;
    const qbx = await run(mixed, { mode: 'qbx' });
    expect(qbx.lines).toEqual([
      'integration: SKIP own: needs a standalone run, and this is the qbx run',
      'integration: PASS theirs',
      'integration: SKIP own-too: needs a standalone run, and this is the qbx run',
      'integration: done 1 passed 0 failed'
    ]);
    expect(qbx.result).toEqual({ passed: 1, failed: 0, skipped: 2 });
    expect(ran).toEqual(['theirs']);
  });

  it('fails, rather than skips, a scenario whose mode is not one of the two', async () => {
    const odd = { ...scenario('odd', async () => {}), mode: 'esx' } as unknown as Scenario;
    const { lines, result } = await run([odd]);
    expect(lines).toEqual([
      "integration: FAIL odd: has mode 'esx', which is not a mode",
      'integration: done 0 passed 1 failed'
    ]);
    expect(result).toEqual({ passed: 0, failed: 1, skipped: 0 });
  });

  it('does not let a skipped scenario spend the budget or shadow a later one with its id', async () => {
    const { lines } = await run(
      [
        scenario('theirs', never, undefined, 'qbx'),
        scenario('theirs', async () => {}, undefined, 'qbx'),
        scenario('own', async () => {})
      ],
      { budgetMs: 50 }
    );
    // A second scenario with a skipped one's id is still the duplicate it is.
    expect(lines).toEqual([
      'integration: SKIP theirs: needs a qbx run, and this is the standalone run',
      'integration: FAIL theirs: a second scenario has this id; not run',
      'integration: PASS own',
      'integration: done 1 passed 1 failed'
    ]);
  });
});

/**
 * MICA-304. The suite as it is registered, held to the numbers the wrapper's lists are packed
 * from. The two counts below are the run's skips: a scenario added to either mode changes one,
 * which is the point of writing them down, since a count nobody had to update is a scenario
 * nobody had to decide the mode of.
 */
describe('the registered suite', () => {
  const STANDALONE = 27;
  const QBX = 7;

  const printed = async (mode: Mode) => {
    const lines: string[] = [];
    // Nothing runs: the other run's scenarios are the only ones this asks about, so the run
    // function is replaced by one that records its id and the skips are read off the output.
    const probe = registered.map((entry) => ({
      ...entry,
      run: async () => {
        lines.push(`ran ${entry.id}`);
      }
    }));
    const result = await runScenarios(probe, {
      print: (line) => lines.push(line),
      mode,
      defaultTimeoutMs: 1_000,
      budgetMs: 60_000
    });
    return { lines, result };
  };

  it('has a mode on every scenario, from the two there are', () => {
    expect(registered.length).toBe(STANDALONE + QBX);
    for (const entry of registered) expect(MODES).toContain(entry.mode);
    expect(registered.filter((e) => e.mode === 'standalone')).toHaveLength(STANDALONE);
    expect(registered.filter((e) => e.mode === 'qbx')).toHaveLength(QBX);
  });

  it('skips every standalone scenario, loudly, in the qbx run, and runs every qbx one', async () => {
    const { lines, result } = await printed('qbx');
    expect(result).toEqual({ passed: QBX, failed: 0, skipped: STANDALONE });
    expect(lines.filter((l) => l.startsWith('integration: SKIP '))).toHaveLength(STANDALONE);
    expect(lines.filter((l) => l.startsWith('ran '))).toHaveLength(QBX);
    for (const entry of registered) {
      const printedFor = lines.some((l) => l.startsWith(`integration: SKIP ${entry.id}:`));
      expect(printedFor, entry.id).toBe(entry.mode === 'standalone');
    }
  });

  it('skips every qbx scenario, loudly, in the standalone run, and runs every standalone one', async () => {
    const { lines, result } = await printed('standalone');
    expect(result).toEqual({ passed: STANDALONE, failed: 0, skipped: QBX });
    expect(lines.filter((l) => l.startsWith('integration: SKIP '))).toHaveLength(QBX);
  });

  it('is what the packer reads from the source, id for id and mode for mode', () => {
    // The packer cannot import TypeScript, so it reads the declarations with a pattern. If the
    // two ever disagree, the wrapper's lists are for a different suite than the one that runs.
    const dir = resolvePath(__dirname, '../../integration/scenarios');
    const packed = scenarioIds(
      readdirSync(dir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
    ) as Array<{ id: string; mode: string }>;
    const real = registered
      .map((e) => ({ id: e.id, mode: e.mode }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(packed).toEqual(real);
  });
});

describe('the console tap', () => {
  it('splits a print into clean lines, colour codes and blank lines dropped', () => {
    expect(consoleLines('^2[mica] schema is up to date.^7\n\n\u001b[31mred\u001b[0m\r\n')).toEqual([
      '[mica] schema is up to date.',
      'red'
    ]);
    expect(consoleLines(undefined)).toEqual([]);
  });

  it('reads only what was said after a mark, and skips its own channel', async () => {
    const tap = new ConsoleTap('script:mica-integration');
    tap.push('script:mica', '[mica] before\n');
    const mark = tap.mark();
    tap.push('script:mica-integration', 'integration: PASS x\n');
    tap.push('script:mica', '[mica] after\n');
    expect(tap.since(mark)).toEqual(['[mica] after']);
    const signal = { aborted: false };
    await expect(tap.waitFor(mark, /^\[mica\] after$/, 50, signal, 'it')).resolves.toBe(
      '[mica] after'
    );
    await expect(
      tap.waitFor(mark, /^\[mica\] before$/, 50, signal, 'the old line')
    ).rejects.toThrow(/no the old line within 50 ms; said: \[mica\] after/);
  });

  it("reads FXServer's console.error and console.warn lines as micaOS wrote them", () => {
    // MICA-302's first hoth run: keygen's refusal arrived as `Error: [micacrypt] …`, and a match
    // anchored on `[micacrypt]` waited out its whole timeout beside it.
    expect(
      consoleLines(
        'Error: [micacrypt] keygen refused: /k could not be written (Error: Access denied).'
      )
    ).toEqual(['[micacrypt] keygen refused: /k could not be written (Error: Access denied).']);
    expect(consoleLines('Warning: [micaOS] the key file is inside server-data.')).toEqual([
      '[micaOS] the key file is inside server-data.'
    ]);
    // Only before a tag: a line that merely says "Error:" keeps it.
    expect(consoleLines('Error: something without a tag')).toEqual([
      'Error: something without a tag'
    ]);
  });

  it("names oxmysql's and the runtime's lines about micaOS when the expected line never comes", async () => {
    const tap = new ConsoleTap('script:mica-integration');
    const mark = tap.mark();
    tap.push('script:oxmysql', 'mica was unable to complete a transaction!\n');
    tap.push(
      'citizen-scripting-node',
      "Filesystem write permission check from 'mica' for permission fs.write - write not allowed\n"
    );
    tap.push('script:other', 'unrelated chatter\n');
    await expect(
      tap.waitFor(mark, /^\[micaimport\] done$/, 30, { aborted: false }, 'the report')
    ).rejects.toThrow(
      /said: mica was unable to complete a transaction! \| Filesystem write permission check from 'mica'/
    );
  });
});
