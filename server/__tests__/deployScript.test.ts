// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY, canRun, trialMissing } from './wrapperHarness';

/**
 * `scripts/deploy/deploy.sh`, as far as it can run off the box: the target it is given and the
 * lock it shares with the smoke wrapper. Everything past the lock (the checkout under
 * /opt/fivem-<target>, the image, the unit, the RCON reload) is hoth's, and what a real deploy
 * answers. The trial points XDG_RUNTIME_DIR at a directory of its own, and a checkout that does
 * not exist here ends the run at its `cd`, right after the lock.
 */

const SCRIPT = join(DEPLOY, 'deploy.sh');
const trial = canRun(trialMissing(), 'the deploy script tests');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-deploy-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const deploy = (args: string[]) => {
  const runtime = join(dir, `run${++n}`);
  spawnSync('mkdir', ['-p', runtime]);
  const r = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: runtime, XDG_RUNTIME_DIR: runtime },
    timeout: 30_000
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, lock: join(runtime, 'mica-hoth.lock') };
};

describe.skipIf(!trial)('deploy.sh', () => {
  it.each([[[]], [['prod']], [['../main']], [['Dev']]])(
    'refuses a target that is not dev or main, before taking the lock: %j',
    (args) => {
      const r = deploy(args);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('usage');
      expect(existsSync(r.lock)).toBe(false);
    }
  );

  it("leaves the lock 0644 and empty, the shape the smoke wrapper accepts as this account's", () => {
    // /opt/fivem-<target> is not here, so the run ends at its `cd`, after the lock.
    if (existsSync('/opt/fivem-dev/server-data/vendor/mica')) return;
    const r = deploy(['dev']);
    expect(r.status).not.toBe(0);
    expect(statSync(r.lock).mode & 0o777).toBe(0o644);
    expect(readFileSync(r.lock, 'utf8')).toBe('');
  });
});
