// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

describe('check-action-versions', () => {
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
