// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  doneLine,
  failLine,
  oneLine,
  passLine,
  runScenarios,
  type RunSignal,
  type Scenario
} from '../../integration/runner';
import { consoleLines, ConsoleTap } from '../../integration/lib/console';

/**
 * MICA-302: the integration runner, held to the protocol the release harness reads. The harness
 * fails a run on any FAIL line and on a missing done line, so the properties pinned here are the
 * exact line shapes, the order, and that one scenario's throw, rejection or hang never costs the
 * others their turn or the run its done line.
 */

const scenario = (id: string, run: Scenario['run'], timeoutMs?: number): Scenario => ({
  id,
  tickets: ['MICA-302'],
  run,
  ...(timeoutMs === undefined ? {} : { timeoutMs })
});

const run = async (
  scenarios: Scenario[],
  over: { budgetMs?: number; defaultTimeoutMs?: number } = {}
) => {
  const lines: string[] = [];
  const result = await runScenarios(scenarios, {
    print: (line) => lines.push(line),
    defaultTimeoutMs: over.defaultTimeoutMs ?? 1_000,
    budgetMs: over.budgetMs ?? 10_000
  });
  return { lines, result };
};

const never = (): Promise<void> => new Promise<void>(() => {});

describe('the protocol lines', () => {
  it('are exactly the three shapes the harness greps for', () => {
    expect(passLine('schema-ok')).toBe('integration: PASS schema-ok');
    expect(failLine('schema-ok', 'missing tables: a, b')).toBe(
      'integration: FAIL schema-ok: missing tables: a, b'
    );
    expect(doneLine(3, 1)).toBe('integration: done 3 passed 1 failed');
    expect(doneLine(0, 0)).toBe('integration: done 0 passed 0 failed');
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
    expect(result).toEqual({ passed: 3, failed: 0 });
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
    expect(result).toEqual({ passed: 1, failed: 3 });
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
    expect(result).toEqual({ passed: 0, failed: 2 });
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
    ).rejects.toThrow(/no the old line within 50 ms; micaOS said: \[mica\] after/);
  });
});
