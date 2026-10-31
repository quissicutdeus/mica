// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * How the workflows reach hoth's smoke wrapper.
 *
 * `run-checked.sh` is the SSH session plus the two things a workflow step gets wrong by hand: a
 * pipe that reports `tee`'s status instead of the session's, and a run that exited 0 without
 * making every run the workflow expects (RUN_CHECKED_REQUIRE, MICA-304). Every case below is a
 * way for the step to be fooled into a pass, held to a non-zero exit. What this cannot show is
 * hoth: whether the wrapper there passes is what a real run answers.
 */

const ROOT = resolve(__dirname, '../..');
const RUN = join(ROOT, 'scripts/deploy/run-checked.sh');

const usable = process.platform === 'linux' || process.platform === 'darwin';

/** A stand-in for `ssh`: prints what the case says, reads stdin if asked, exits as told. */
const session = (script: string) => ['sh', '-c', script];

const run = (command: string[], input = '', require?: string) => {
  const r = spawnSync('sh', [RUN, ...command], {
    encoding: 'utf8',
    input,
    env: { ...process.env, RUN_CHECKED_REQUIRE: require ?? '' }
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
};

describe.skipIf(!usable)('run-checked.sh', () => {
  it('passes a session that succeeded, and passes its output through', () => {
    const r = run(session('echo before; echo after'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('before');
    expect(r.stdout).toContain('after');
  });

  it("does not let tee's success hide a failed session", () => {
    const r = run(session('echo died early >&2; exit 7'));
    expect(r.status).toBe(7);
    expect(r.out).toContain('died early');
    expect(r.out).toContain('exited 7');
  });

  it('fails when the command does not exist', () => {
    expect(run(['mica-no-such-command-anywhere']).status).not.toBe(0);
  });

  it('hands stdin to the command untouched, as the release zip is piped to ssh', () => {
    const r = run(session('cat'), 'zip bytes here\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('zip bytes here');
  });

  it('refuses without a command', () => {
    expect(spawnSync('sh', [RUN], { encoding: 'utf8' }).status).toBe(2);
  });

  /**
   * MICA-304. A wrapper edited to leave a run out exits 0. The workflow names the lines a full
   * run prints, and a run without one is red.
   */
  describe('RUN_CHECKED_REQUIRE', () => {
    const REQUIRE =
      '[standalone mode] integration suite passed\n[qbx mode] integration suite passed';
    const both =
      "echo 'smoke: [standalone mode] integration suite passed -- 3'; echo 'smoke: [qbx mode] integration suite passed -- 6'";

    it('passes when every required line is in the output, and is no check when unset', () => {
      expect(run(session(both), '', REQUIRE).status).toBe(0);
      expect(run(session(both), '', '').status).toBe(0);
      expect(run(session('echo smoke: ok')).status).toBe(0);
    });

    it('counts a line printed on stderr, since the session merges the two', () => {
      expect(run(session(`{ ${both}; } >&2`), '', REQUIRE).status).toBe(0);
    });

    it('fails a run that exited 0 when one required line is missing, and names it', () => {
      const r = run(
        session("echo 'smoke: [standalone mode] integration suite passed -- 3'"),
        '',
        REQUIRE
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain('the output never said `[qbx mode] integration suite passed`');
      expect(r.out).not.toContain('never said `[standalone mode]');
    });

    it('fails when none of the required lines is there', () => {
      expect(run(session('echo smoke: ok'), '', REQUIRE).status).toBe(1);
    });

    it('keeps the command failure ahead of a missing line', () => {
      expect(run(session(`${both}; exit 7`), '', REQUIRE).status).toBe(7);
    });
  });
});

/**
 * The call sites. Every SSH session to hoth goes to the fivem account, and every one that reaches
 * the smoke wrapper goes through `run-checked.sh` with the lines the run must print; a bare
 * `ssh ... | tee` there would be green when the run was red.
 */
describe('the workflows that reach hoth', () => {
  const read = (f: string) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
  const sites: Array<[file: string, sessions: number, checked: number]> = [
    ['deploy.yml', 2, 0],
    ['release.yml', 2, 2],
    ['integration.yml', 1, 1]
  ];

  it.each(sites)('%s opens %i session(s) to fivem@, %i through run-checked.sh', (file, n, c) => {
    const text = read(file);
    expect(text.match(/fivem@"\$DEPLOY_HOST"/g) ?? []).toHaveLength(n);
    expect(text.match(/run-checked\.sh \\\n\s+ssh /g) ?? []).toHaveLength(c);
  });

  it('names no other account on the box', () => {
    for (const [file] of sites) {
      const text = read(file);
      expect(text, file).not.toMatch(/gphone@|root@/);
    }
  });

  it('requires a pass line from every integration mode wherever the suite runs', () => {
    for (const file of ['release.yml', 'integration.yml']) {
      const text = read(file);
      for (const mode of ['standalone', 'qbx', 'esx']) {
        expect(text, file).toContain(`[${mode} mode] integration suite passed`);
      }
      expect(text, file).toContain('integration passed in every run');
    }
  });
});
