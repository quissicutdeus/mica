// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/watch-ci.sh decides whether a pushed commit is green. These drive the real script
// with a fake `gh` that prints canned `id status conclusion workflow` rows, so the verdict
// is exercised, not just configured.

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'watch-ci.sh');
const SHA = 'a'.repeat(40);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-ci-'));
  const gh = join(dir, 'gh');
  // Ignores its arguments and prints the rows in $FAKE_RUNS, as the script's --jq would.
  writeFileSync(gh, '#!/bin/sh\nprintf "%s" "$FAKE_RUNS"\n');
  chmodSync(gh, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Row = [id: number, status: string, conclusion: string, workflow: string];

function watch(rows: Row[]) {
  const runs = rows.map((r) => r.join('\t') + '\n').join('');
  const r = spawnSync('sh', [SCRIPT, '-R', 'o/r', SHA], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_RUNS: runs,
      WATCH_CI_INTERVAL: '0',
      WATCH_CI_QUIET: '2',
      WATCH_CI_POLLS: '6'
    }
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('scripts/watch-ci.sh verdict', () => {
  it('a failure superseded by a newer success passes, and is still printed as superseded', () => {
    const r = watch([
      [42746645805, 'completed', 'failure', 'Integration'],
      [42747553273, 'completed', 'success', 'Integration']
    ]);
    expect(r.code).toBe(0);
    const old = r.out.split('\n').find((l) => l.includes('42746645805'));
    expect(old).toBeDefined();
    expect(old).toContain('failure');
    expect(old).toContain('superseded');
    expect(r.out.split('\n').find((l) => l.includes('42747553273'))).not.toContain('superseded');
  });

  it('a success superseded by a newer failure fails', () => {
    const r = watch([
      [100, 'completed', 'success', 'Integration'],
      [200, 'completed', 'failure', 'Integration']
    ]);
    expect(r.code).toBe(1);
  });

  it('a newer run that is still running keeps the watch pending, not green', () => {
    const r = watch([
      [100, 'completed', 'failure', 'Integration'],
      [200, 'in_progress', 'none', 'Integration']
    ]);
    expect(r.code).toBe(1);
  });

  it('a lone failure fails', () => {
    expect(watch([[100, 'completed', 'failure', 'Integration']]).code).toBe(1);
  });

  it('a different workflow failing alongside a superseded one still fails', () => {
    const r = watch([
      [100, 'completed', 'failure', 'Integration'],
      [200, 'completed', 'success', 'Integration'],
      [150, 'completed', 'failure', 'Verify']
    ]);
    expect(r.code).toBe(1);
  });

  it('a higher id in a different workflow does not supersede', () => {
    const r = watch([
      [100, 'completed', 'failure', 'Verify'],
      [200, 'completed', 'success', 'Integration']
    ]);
    expect(r.code).toBe(1);
  });

  it('no runs at all fails', () => {
    expect(watch([]).code).toBe(1);
  });
});
