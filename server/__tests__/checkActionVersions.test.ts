// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The two refusals `scripts/check-action-versions.js` makes before it touches the network:
 * a `uses:` that is not a commit SHA, and a SHA with no version comment to check a major
 * against. Each is driven through `--dir` on a one-workflow fixture, so the failing paths
 * are shown to fire without pushing a deliberately broken `uses:` to find out.
 *
 * Nothing here runs the script over the real `.github/workflows/`, and that is the point.
 * The happy path needs the GitHub API, and a unit suite that reaches the API fails on
 * whatever the runner's shared anonymous rate limit is doing that minute -- 31 lookups
 * came back 403 in CI on the first push (MICA-199). `action-drift.yml` runs the script
 * for real, with a token; `pnpm lint:actions` is the same run by hand.
 */
const workflowDir = (uses: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mica-actions-'));
  writeFileSync(path.join(dir, 'ci.yml'), `jobs:\n  x:\n    steps:\n      - uses: ${uses}\n`);
  return dir;
};

const run = (dir: string) =>
  spawnSync('node', ['scripts/check-action-versions.js', `--dir=${dir}`], {
    cwd: path.resolve('.'),
    encoding: 'utf8'
  });

describe('check-action-versions', () => {
  it('fails on a tag pin, naming it NOT SHA', () => {
    const result = run(workflowDir('actions/checkout@v7'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('NOT SHA   actions/checkout@v7');
  });

  it('fails on a SHA pin with no version comment, as unresolved rather than current', () => {
    const result = run(workflowDir('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNKNOWN');
    expect(result.stdout).toContain('no version comment');
    expect(result.stdout).not.toContain('  ok ');
  });

  it('fails on a comment that is not a vN tag, without guessing a major from it', () => {
    const result = run(
      workflowDir('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # main')
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("comment 'main' is not a vN tag");
  });
});
