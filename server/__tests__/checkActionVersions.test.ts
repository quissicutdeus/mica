// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The refusals `scripts/check-action-versions.js` makes before it touches the network: a
 * `uses:` that is not a bare major tag -- a commit SHA, an exact version, a branch -- and a
 * hold that gives no reason. Each is driven through `--dir` on a one-workflow fixture, so
 * the failing paths are shown to fire without pushing a deliberately broken `uses:` to
 * find out.
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
    encoding: 'utf8',
    timeout: 30_000
  });

/**
 * Each case cold-starts a `node` process, which the 5 s default does not always cover on a
 * shared CI runner with both Vitest projects running at once: "fails on a tag pin" took
 * 5257 ms there on e4b4cb30 and failed for it, with nothing wrong. The script never reaches
 * the network on these paths, so a case that does take 30 s has hung, and `spawnSync`'s own
 * `timeout` above ends the child first so the assertion names it.
 */
const SPAWN_CASE_TIMEOUT_MS = 45_000;

describe('check-action-versions', { timeout: SPAWN_CASE_TIMEOUT_MS }, () => {
  it('fails on a commit SHA, naming it NOT MAJOR', () => {
    const result = run(workflowDir('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'NOT MAJOR actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
    );
    expect(result.stdout).not.toContain('  ok ');
  });

  it('fails on an exact version, which holds the action at one release', () => {
    const result = run(workflowDir('actions/checkout@v7.0.1'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('NOT MAJOR actions/checkout@v7.0.1');
  });

  it('fails on a branch, without guessing a major from it', () => {
    const result = run(workflowDir('actions/checkout@main'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('NOT MAJOR actions/checkout@main');
  });

  /**
   * A hold is the one way a tag may stay an older major, and it has to say why where the
   * tag is. Neither case below reaches the network: a hold is not compared to the latest
   * major at all, which is the whole point of it.
   */
  it('accepts a tag held at an older major when the hold gives its reason', () => {
    const result = run(
      workflowDir('actions/upload-artifact@v3 # held: v4+ refuses non-github.com hosts')
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'held      actions/upload-artifact@v3: v4+ refuses non-github.com hosts'
    );
  });

  it("refuses 'held:' with no reason, so the marker cannot silence the check quietly", () => {
    const result = run(workflowDir('actions/upload-artifact@v3 # held:'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("'held:' with no reason is not a hold");
  });

  /**
   * On Forgejo the job's `GITHUB_TOKEN` is Forgejo's, and sending it to api.github.com
   * turned every lookup into a 401 (runs 85 and 86). A held tag keeps both cases off the
   * network; what is asserted is only whether the token was accepted.
   */
  const HELD_PIN = 'actions/upload-artifact@v3 # held: v4+ refuses non-github.com hosts';
  const runWith = (env: Record<string, string>) =>
    spawnSync('node', ['scripts/check-action-versions.js', `--dir=${workflowDir(HELD_PIN)}`], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, ...env }
    });

  it('does not send a GITHUB_TOKEN that another server issued to api.github.com', () => {
    const result = runWith({
      GITHUB_TOKEN: 'forgejo-token',
      GITHUB_SERVER_URL: 'https://git.example.com'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'ignoring GITHUB_TOKEN: it was issued by https://git.example.com, not github.com'
    );
  });

  it('keeps a GITHUB_TOKEN that github.com issued', () => {
    const result = runWith({
      GITHUB_TOKEN: 'github-token',
      GITHUB_SERVER_URL: 'https://github.com'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ignoring GITHUB_TOKEN');
  });
});
