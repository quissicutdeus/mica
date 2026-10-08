// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
// @ts-expect-error -- a plain .js build script with no declaration file (declaring one is a non-test change).
import { AGENT_ENV_VARS, gateEnv, gateEnvNotice } from '../../scripts/lib/gate-env.js';

/**
 * `pnpm verify` strips the agent markers from every gate's environment (MICA-312's
 * follow-up: `ac815c3d` passed under `CLAUDECODE=1` and failed CI, because svelte-check
 * prints a different format for an agent).
 *
 * `scripts/verify.js` runs its gates on import, so the part that decides the environment
 * lives in `scripts/lib/gate-env.js` and is tested here, with a real child process reading
 * what it was given. The last case holds the wiring: the pure function proves nothing if
 * `run` stops passing its result to `spawn`, and nothing else would notice.
 */
describe('gateEnv', () => {
  const both = { CLAUDECODE: '1', CLAUDE_CODE: '1', PATH: process.env.PATH ?? '', KEEP: 'me' };

  it('removes exactly CLAUDECODE and CLAUDE_CODE and reports both', () => {
    const { env, removed } = gateEnv(both);
    expect(Object.keys(env).sort()).toEqual(['KEEP', 'PATH']);
    expect(env.KEEP).toBe('me');
    expect(removed).toEqual(['CLAUDECODE', 'CLAUDE_CODE']);
  });

  it('leaves the CLAUDE_CODE_* family alone', () => {
    const family = {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDECODE: '1'
    };
    const { env, removed } = gateEnv(family);
    expect(env).toEqual({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'abc' });
    expect(removed).toEqual(['CLAUDECODE']);
  });

  it('does not touch the object it was given', () => {
    const input = { ...both };
    gateEnv(input);
    expect(input).toEqual(both);
  });

  it('treats a variable set to the empty string as present', () => {
    const { env, removed } = gateEnv({ CLAUDE_CODE: '' });
    expect(env).toEqual({});
    expect(removed).toEqual(['CLAUDE_CODE']);
  });

  it('hands a real child process neither variable', () => {
    const { env } = gateEnv(both);
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify([process.env.CLAUDECODE ?? null, process.env.CLAUDE_CODE ?? null, process.env.KEEP ?? null]))'
      ],
      { env, encoding: 'utf8' }
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([null, null, 'me']);
  });

  it('names the two variables it strips', () => {
    expect([...AGENT_ENV_VARS]).toEqual(['CLAUDECODE', 'CLAUDE_CODE']);
  });
});

describe('gateEnvNotice', () => {
  it('says nothing when nothing was removed', () => {
    expect(gateEnvNotice(gateEnv({ PATH: '/bin' }).removed)).toBeNull();
  });

  it('is one line naming what was removed and why when something was', () => {
    const notice = gateEnvNotice(gateEnv({ CLAUDECODE: '1', CLAUDE_CODE: '1' }).removed);
    expect(notice).toBe(
      "verify: removed CLAUDECODE, CLAUDE_CODE from the gates' environment, so the gates see what CI sees."
    );
    expect(notice).not.toContain('\n');
  });

  it('names only the variable that was set', () => {
    const notice = gateEnvNotice(gateEnv({ CLAUDECODE: '1' }).removed);
    expect(notice).toContain('CLAUDECODE');
    expect(notice).not.toContain('CLAUDE_CODE,');
  });
});

describe('scripts/verify.js wiring', () => {
  const source = readFileSync('scripts/verify.js', 'utf8');

  it('builds the gate environment from process.env and passes it to the one spawn', () => {
    expect(source).toMatch(/gateEnv\(process\.env\)/);
    expect(source.match(/\bspawn\(/g)).toHaveLength(1);
    expect(source).toMatch(/spawn\(command, args, \{[^}]*\benv: GATE_ENV\b/s);
  });

  it('no gate call supplies its own env', () => {
    // Every gate call today passes no options. If one starts passing `env`, it would replace
    // the stripped environment for that gate alone, so this fails and makes it a decision.
    expect(source).not.toMatch(/gate\([^)]*\{[^}]*\benv\b/);
  });

  it('prints the notice from main, before the first gate', () => {
    const notice = source.indexOf('gateEnvNotice(REMOVED_ENV)');
    const firstGate = source.indexOf("await gate('barrels'");
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(firstGate);
  });
});
