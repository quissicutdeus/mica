// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { judge, parseBaseline, parseTscOutput } from '../../scripts/check-test-types.js';

/**
 * `scripts/check-test-types.js` fires (MICA-320).
 *
 * The gate is only worth having if both halves of its contract can fail: an unlisted test
 * that breaks, and a listed test that was fixed but left on the list. The first block drives
 * the judgement directly; the last runs the script for real against a doctored copy of the
 * baseline, because the contract is its exit code.
 */

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/check-test-types.js');

const always = () => true;

describe('judge', () => {
  it('passes when failing files and the baseline agree', () => {
    expect(judge(new Set(['a.ts', 'b.ts']), ['a.ts', 'b.ts'], always)).toEqual([]);
  });

  it('fails a test that is not in the baseline', () => {
    const problems: string[] = judge(new Set(['a.ts', 'new.ts']), ['a.ts'], always);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^NEW\s+new\.ts/);
  });

  it('fails a baselined test that now passes', () => {
    const problems: string[] = judge(new Set(['a.ts']), ['a.ts', 'fixed.ts'], always);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^FIXED\s+fixed\.ts/);
  });

  it('fails a baseline entry for a file that is gone, and a duplicate', () => {
    expect(judge(new Set(), ['gone.ts'], () => false)[0]).toMatch(/^GONE/);
    expect(judge(new Set(['a.ts']), ['a.ts', 'a.ts'], always).join('\n')).toMatch(/DUP/);
  });
});

describe('parsing', () => {
  it('reads comments and blanks out of the baseline', () => {
    expect(parseBaseline('# c\n\nserver/__tests__/a.test.ts # why\n')).toEqual([
      'server/__tests__/a.test.ts'
    ]);
  });

  it('groups located diagnostics by file and keeps unlocated ones apart', () => {
    const out = [
      "server/__tests__/a.test.ts(3,5): error TS2304: Cannot find name 'x'.",
      'server/__tests__/a.test.ts(9,1): error TS2554: Expected 1 arguments, but got 2.',
      '    continuation line',
      "error TS5058: The specified path does not exist: 'nope'."
    ].join('\n');
    const { byFile, unlocated } = parseTscOutput(out);
    expect([...byFile.keys()]).toEqual(['server/__tests__/a.test.ts']);
    expect(byFile.get('server/__tests__/a.test.ts')).toHaveLength(2);
    expect(unlocated).toHaveLength(1);
  });
});

describe('the script, run for real', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A scratch tree shaped like the repo's: `server/` and `client/` each with a tsconfig.tests.json
   * and a `__tests__/`, holding `bad` files that fail typecheck and one that does not. Nothing
   * here depends on what the real tests do today, so the proof holds for a baseline of any size.
   */
  const fixture = (bad: number) => {
    const root = mkdtempSync(join(tmpdir(), 'mica-test-types-'));
    dirs.push(root);
    for (const target of ['server', 'client']) {
      mkdirSync(join(root, target, '__tests__'), { recursive: true });
      writeFileSync(
        join(root, target, 'tsconfig.tests.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            types: [],
            module: 'esnext',
            target: 'es2022'
          },
          include: ['./__tests__/**/*']
        })
      );
      writeFileSync(
        join(root, target, '__tests__', 'clean.test.ts'),
        'export const ok: number = 1;\n'
      );
    }
    const failing: string[] = [];
    for (let i = 0; i < bad; i++) {
      const rel = `server/__tests__/bad${i}.test.ts`;
      writeFileSync(join(root, rel), "export const broken: number = 'no';\n");
      failing.push(rel);
    }
    return { root, failing, clean: 'server/__tests__/clean.test.ts' };
  };

  const run = (root: string, baseline: string[]) => {
    const file = join(root, 'baseline.txt');
    writeFileSync(file, `# fixture\n${baseline.join('\n')}\n`);
    return spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MICA_TEST_TYPES_ROOT: root, MICA_TEST_TYPES_BASELINE: file }
    });
  };

  it.each([0, 1, 31])(
    'with %i failing tests',
    (bad) => {
      const { root, failing, clean } = fixture(bad);

      const agree = run(root, failing);
      expect(agree.stderr).toBe('');
      expect(agree.status).toBe(0);

      // A new break: one more failing file than the baseline lists.
      writeFileSync(
        join(root, 'server/__tests__/newbreak.test.ts'),
        "export const n: number = 'x';\n"
      );
      const unlisted = run(root, failing);
      expect(unlisted.status).toBe(1);
      expect(unlisted.stderr).toContain('NEW  server/__tests__/newbreak.test.ts');
      rmSync(join(root, 'server/__tests__/newbreak.test.ts'));

      // A stale entry: a listed file that typechecks.
      const stale = run(root, [...failing, clean]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain(`FIXED ${clean}`);
    },
    60_000
  );

  it('fails loudly when tsc cannot read its config', () => {
    const { root } = fixture(0);
    rmSync(join(root, 'client/tsconfig.tests.json'));
    const r = run(root, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toBe('');
  }, 60_000);
});
