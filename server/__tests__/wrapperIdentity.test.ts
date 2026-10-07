// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The staleness check on hoth's root-owned wrappers.
 *
 * `/usr/local/sbin/mica-*.sh` are installed by hand and cannot be updated by CI, so a change
 * to the repo's copy that nobody reinstalls leaves hoth running the old one with nothing to
 * say so (MICA-306). Each wrapper prints `mica-wrapper: <name> sha256 <hex>` first thing;
 * `check-wrapper-identity.sh` holds an SSH session's output to the checked-out copy's hash,
 * and `run-checked.sh` is how every workflow step that reaches a wrapper calls it.
 *
 * Every case below is a way for the check to be fooled into a pass, held to a non-zero exit:
 * the line absent, stale, malformed, forged by a prefix, or contradicted by a second one; and
 * a failed SSH session masked by the pipe that captures its output. What this cannot show is
 * hoth: whether the box's copy is current is exactly what a real run answers.
 */

const ROOT = resolve(__dirname, '../..');
const DEPLOY = join(ROOT, 'scripts/deploy');
const CHECK = join(DEPLOY, 'check-wrapper-identity.sh');
const RUN = join(DEPLOY, 'run-checked.sh');

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const WRAPPERS = readdirSync(DEPLOY).filter((f) => /^mica-.*\.sh$/.test(f));
const NAME = 'mica-smoke-release.sh';
const GOOD = sha(join(DEPLOY, NAME));
const STALE = 'a'.repeat(64);

const line = (hash: string, name = NAME) => `mica-wrapper: ${name} sha256 ${hash}`;

const usable =
  process.platform === 'linux' &&
  spawnSync('sh', ['-c', 'command -v sha256sum >/dev/null || command -v shasum']).status === 0;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-identity-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** Run the check over what the session printed, as a file. */
const check = (output: string, name = NAME) => {
  const file = join(dir, `out${++n}`);
  writeFileSync(file, output);
  const r = spawnSync('sh', [CHECK, name, file], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const installCommand = (name: string) =>
  `sudo install -m 700 -o root -g root scripts/deploy/${name} /usr/local/sbin/`;

describe.skipIf(!usable)('check-wrapper-identity.sh', () => {
  it("passes when hoth reports this checkout's hash", () => {
    const r = check(`${line(GOOD)}\nsmoke: ok\n`);
    expect(r.status).toBe(0);
    expect(r.out).toContain(GOOD);
  });

  it('finds the line among other output, before it, after it, and with no final newline', () => {
    const noise = ['fxserver booting', 'Started resource mica', '[mica] schema ok'];
    expect(check([...noise, line(GOOD), ...noise].join('\n') + '\n').status).toBe(0);
    expect(check([...noise, line(GOOD)].join('\n')).status).toBe(0);
    expect(check(`${line(GOOD)}\r\nsmoke: ok\r\n`).status).toBe(0);
  });

  it('fails on a different hash, and says both, the wrapper, and the exact command', () => {
    const r = check(`${line(STALE)}\n`);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hoth's \`${NAME}\` is stale or missing: reinstall it`);
    expect(r.out).toContain(installCommand(NAME));
    expect(r.out).toContain(GOOD);
    expect(r.out).toContain(STALE);
  });

  it('fails when there is no identity line at all: a wrapper too old to print one', () => {
    for (const output of ['', '\n', 'smoke: ok\nmica started!\n']) {
      const r = check(output);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`hoth's \`${NAME}\` is stale or missing: reinstall it`);
      expect(r.out).toContain(installCommand(NAME));
      expect(r.out).toContain(GOOD);
    }
  });

  it("fails when only another wrapper's line is there", () => {
    const r = check(`${line(GOOD, 'mica-deploy-dev-compose.sh')}\n`);
    expect(r.status).toBe(1);
    expect(r.out).toContain('is stale or missing');
  });

  it('passes several lines only if every one is current, and fails if any is stale', () => {
    expect(check(`${line(GOOD)}\nx\n${line(GOOD)}\n`).status).toBe(0);
    const mixed = check(`${line(GOOD)}\n${line(STALE)}\n`);
    expect(mixed.status).toBe(1);
    expect(mixed.out).toContain(STALE);
    expect(check(`${line(STALE)}\n${line(GOOD)}\n`).status).toBe(1);
  });

  it('does not count a look-alike that a console prefixed, or one with a malformed hash', () => {
    // A resource's output arrives prefixed; it cannot stand in for the wrapper's own line.
    expect(check(`[script:evil] ${line(GOOD)}\n`).status).toBe(1);
    expect(check(` ${line(GOOD)}\n`).status).toBe(1);
    // Short, upper case, non-hex, empty and trailing-garbage values are not hashes.
    for (const bad of [GOOD.slice(0, 63), GOOD.toUpperCase(), `${GOOD.slice(0, 63)}g`, '']) {
      expect(check(`${line(bad)}\n`).status).toBe(1);
    }
    expect(check(`${line(GOOD)} extra\n`).status).toBe(1);
  });

  it('reads the output from stdin with `-` and with no second argument', () => {
    for (const args of [[NAME, '-'], [NAME]]) {
      const ok = spawnSync('sh', [CHECK, ...args], { input: `${line(GOOD)}\n`, encoding: 'utf8' });
      expect(ok.status).toBe(0);
      const stale = spawnSync('sh', [CHECK, ...args], { input: '', encoding: 'utf8' });
      expect(stale.status).toBe(1);
    }
  });

  it('refuses, non-zero, what it cannot compare: bad arguments, an unknown or path-like wrapper', () => {
    const bad = (args: string[]) =>
      spawnSync('sh', [CHECK, ...args], { input: '', encoding: 'utf8' });
    expect(bad([]).status).toBe(2);
    expect(bad(['mica-nonexistent.sh']).status).toBe(2);
    expect(bad(['../deploy/mica-smoke-release.sh']).status).toBe(2);
    expect(bad(['/etc/passwd']).status).toBe(2);
    expect(bad(['..']).status).toBe(2);
    expect(bad([NAME, join(dir, 'does-not-exist')]).status).toBe(2);
    expect(bad([NAME, 'a', 'b']).status).toBe(2);
  });

  it.each(WRAPPERS)('%s prints a line this check accepts, before any guard can refuse', (name) => {
    // Bare, with nothing the wrapper needs: it refuses at its first guard, which is after the
    // identity line, and touches nothing. The deploy wrappers want MICA_PORT and the rest, the
    // smoke wrapper wants a run directory.
    const r = spawnSync('bash', [join(DEPLOY, name)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      timeout: 30_000
    });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain(line(sha(join(DEPLOY, name)), name));
    const verdict = check(out, name);
    expect(verdict.status).toBe(0);
  });
});

/** A stand-in for `ssh`: prints what the case says, reads stdin if asked, exits as told. */
const session = (script: string) => ['sh', '-c', script];

const run = (name: string, command: string[], input = '') => {
  const r = spawnSync('sh', [RUN, name, ...command], { encoding: 'utf8', input });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
};

describe.skipIf(!usable)('run-checked.sh', () => {
  it('passes only when the command succeeded and the line is current, and passes the output through', () => {
    const r = run(NAME, session(`echo before; echo '${line(GOOD)}'; echo after`));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('before');
    expect(r.stdout).toContain('after');
  });

  it('fails a successful session that reported a stale line, or none', () => {
    const stale = run(NAME, session(`echo '${line(STALE)}'`));
    expect(stale.status).toBe(1);
    expect(stale.out).toContain('is stale or missing: reinstall it');
    const none = run(NAME, session('echo smoke: ok'));
    expect(none.status).toBe(1);
    expect(none.out).toContain(installCommand(NAME));
  });

  it("does not let tee's success hide a failed session, current line or not", () => {
    const r = run(NAME, session(`echo '${line(GOOD)}'; exit 7`));
    expect(r.status).toBe(7);
    expect(r.out).toContain('exited 7');
  });

  it('reports both when a failed session never reached the wrapper, and fails with the first', () => {
    const r = run(NAME, session('echo died early >&2; exit 3'));
    expect(r.status).toBe(3);
    expect(r.out).toContain('died early');
    expect(r.out).toContain('is stale or missing');
    expect(r.out).toContain('exited 3');
  });

  it('counts a line printed on stderr, since the session merges the two', () => {
    expect(run(NAME, session(`echo '${line(GOOD)}' >&2`)).status).toBe(0);
  });

  it('fails when the command does not exist', () => {
    const r = run(NAME, ['mica-no-such-command-anywhere']);
    expect(r.status).not.toBe(0);
  });

  it('hands stdin to the command untouched, as the release zip is piped to ssh', () => {
    const r = run(NAME, session(`echo '${line(GOOD)}'; cat`), 'zip bytes here\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('zip bytes here');
  });

  /**
   * MICA-304. A wrapper edited to leave a run out and then reinstalled has a current hash and
   * exits 0. The workflow names the lines a full run prints, and a run without one is red.
   */
  describe('RUN_CHECKED_REQUIRE', () => {
    const REQUIRE =
      '[standalone mode] integration suite passed\n[qbx mode] integration suite passed';
    const both = `echo '${line(GOOD)}'; echo 'smoke: [standalone mode] integration suite passed -- 3'; echo 'smoke: [qbx mode] integration suite passed -- 6'`;
    const withRequire = (command: string[], required: string) =>
      spawnSync('sh', [RUN, NAME, ...command], {
        encoding: 'utf8',
        env: { ...process.env, RUN_CHECKED_REQUIRE: required }
      });

    it('passes when every required line is in the output, and is no check when unset', () => {
      expect(withRequire(session(both), REQUIRE).status).toBe(0);
      expect(withRequire(session(both), '').status).toBe(0);
      expect(run(NAME, session(`echo '${line(GOOD)}'`)).status).toBe(0);
    });

    it('fails a run that exited 0 and the identity check passed, when one required line is missing', () => {
      const r = withRequire(
        session(
          `echo '${line(GOOD)}'; echo 'smoke: [standalone mode] integration suite passed -- 3'`
        ),
        REQUIRE
      );
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain(
        'the output never said `[qbx mode] integration suite passed`'
      );
      expect(`${r.stdout}${r.stderr}`).not.toContain('never said `[standalone mode]');
    });

    it('fails when none of the required lines is there', () => {
      const r = withRequire(session(`echo '${line(GOOD)}'`), REQUIRE);
      expect(r.status).toBe(1);
    });

    it('keeps the command failure and the stale line ahead of it', () => {
      expect(withRequire(session(`echo '${line(GOOD)}'; exit 7`), REQUIRE).status).toBe(7);
      expect(withRequire(session(`echo '${line(STALE)}'`), REQUIRE).status).toBe(1);
    });
  });

  it('refuses without a wrapper and a command, and for a wrapper it cannot hash', () => {
    expect(spawnSync('sh', [RUN, NAME], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('sh', [RUN], { encoding: 'utf8' }).status).toBe(2);
    expect(run('mica-nonexistent.sh', session(`echo '${line(GOOD)}'`)).status).toBe(2);
  });
});

/**
 * The call sites. A job that reaches a wrapper without `run-checked.sh` is a job that cannot
 * tell it ran a stale one, and the failure is silent: nothing else would notice.
 */
describe('the workflows that reach a root wrapper', () => {
  const read = (f: string) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
  const sites: Array<[file: string, wrapper: string, count: number]> = [
    ['deploy.yml', 'mica-deploy-dev-compose.sh', 1],
    ['deploy.yml', 'mica-deploy-main-compose.sh', 1],
    ['release.yml', 'mica-smoke-release.sh', 2],
    ['integration.yml', 'mica-smoke-release.sh', 1]
  ];

  it.each(sites)('%s checks %s %i time(s)', (file, wrapper, count) => {
    const calls = read(file).match(new RegExp(`run-checked\\.sh ${wrapper}\\b`, 'g')) ?? [];
    expect(calls).toHaveLength(count);
  });

  it('has no ssh to gphone@ that does not go through run-checked.sh', () => {
    for (const file of ['deploy.yml', 'release.yml', 'integration.yml']) {
      const text = read(file);
      const total = (text.match(/gphone@/g) ?? []).length;
      const checked = (text.match(/run-checked\.sh mica-/g) ?? []).length;
      expect(total, `${file}: every gphone@ call is a checked one`).toBe(checked);
    }
  });

  it('knows every root wrapper in scripts/deploy', () => {
    const named = new Set(sites.map(([, w]) => w));
    expect([...named].sort()).toEqual([...WRAPPERS].sort());
  });
});
