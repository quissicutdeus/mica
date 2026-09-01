// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * A one-workflow directory for `--dir`, so the failing paths can be shown to fire without
 * pushing a deliberately broken `uses:` to find out. Neither case below reaches the GitHub
 * API: an unpinned ref and a pin with no comment are both refused before any lookup.
 */
const workflowDir = (uses: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gphone-actions-'));
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

  it('should pass when all actions are SHA-pinned', () => {
    const result = spawnSync('node', ['scripts/check-action-versions.js', '--list'], {
      cwd: path.resolve('.'),
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pinned');
  }, 30000);

  it('should enforce SHA pinning in workflows', () => {
    const result = spawnSync('node', ['scripts/check-action-versions.js'], {
      cwd: path.resolve('.'),
      encoding: 'utf8'
    });

    // Should succeed because all actions are SHA-pinned
    expect(result.status).toBe(0);
  }, 30000);

  it('should parse version comments from actions', () => {
    const result = spawnSync('node', ['scripts/check-action-versions.js', '--list'], {
      cwd: path.resolve('.'),
      encoding: 'utf8'
    });

    expect(result.stdout).toMatch(/\(v\d+/);
  }, 30000);
});
