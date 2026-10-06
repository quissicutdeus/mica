// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What the three root-wrapper suites share: running a wrapper as a trial and holding hoth's lock
 * from outside it (MICA-315). Not a test file; vitest only collects `*.test.ts`.
 */

export const ROOT = resolve(__dirname, '../..');
export const DEPLOY = resolve(ROOT, 'scripts/deploy');

/**
 * Why the wrappers cannot be run as a trial here, or null when they can. They need GNU userland,
 * `flock` and /proc, and ignore their trial overrides as root.
 */
export const trialMissing = (): string | null => {
  if (process.platform !== 'linux') return `the platform is ${process.platform}, not linux`;
  if (process.getuid?.() === 0) {
    return 'the tests are running as root, and the wrappers ignore their trial overrides as root';
  }
  if (spawnSync('sh', ['-c', 'command -v flock']).status !== 0) return '`flock` is not installed';
  if (spawnSync('bash', ['--version']).status !== 0) return '`bash` is not installed';
  return null;
};

/**
 * Why a command cannot be run as uid 0 without being root, or null when it can. In a user
 * namespace bash's $EUID is 0 though nothing privileged is reachable, which is how a wrapper's
 * root branch is exercised.
 */
export const fakeRootMissing = (): string | null => {
  const missing = trialMissing();
  if (missing) return missing;
  if (spawnSync('unshare', ['-Ur', 'sh', '-c', 'test "$(id -u)" = 0']).status !== 0) {
    return (
      '`unshare -Ur` is refused or absent: unprivileged user namespaces are off ' +
      '(kernel.unprivileged_userns_clone=0, or kernel.apparmor_restrict_unprivileged_userns=1 ' +
      'as on GitHub-hosted Ubuntu 24.04 runners)'
    );
  }
  return null;
};

/**
 * On GitHub's own CI a skipped wrapper test is a failure, because a skip reads as a pass and
 * these tests are the only thing holding the wrappers' behaviour. Anywhere else (a developer's
 * machine, the Forgejo mirror whose job containers run as root) it stays a skip, and says why.
 */
const strictSkips = !!process.env.CI && process.env.GITHUB_SERVER_URL === 'https://github.com';

/**
 * Whether `what` can run, given what `missing` found. When it cannot: on GitHub CI this registers
 * one failing test naming the cause, and elsewhere it prints the cause. Either way the caller
 * skips its own suite, so a skip is never silent.
 */
export const canRun = (missing: string | null, what: string): boolean => {
  if (missing === null) return true;
  const message = `${what} cannot run here: ${missing}`;
  if (strictSkips) {
    it(`${what} can run on this machine`, () => {
      throw new Error(
        `${message}. A skip would read as a pass, so on CI it is a failure: make the missing ` +
          'thing available (see the build-test.yml step before Verify) rather than skipping.'
      );
    });
  } else {
    process.stderr.write(`SKIPPED: ${message}\n`);
  }
  return false;
};

/** Block this thread for `ms`. The wrappers are run with spawnSync, so there is no event loop to wait on. */
export const sleepMs = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Is something holding the lock file right now? Asked from a fresh open, as another process would. */
export const lockHeld = (file: string) => spawnSync('flock', ['-n', file, 'true']).status !== 0;

export const holderLine = (file: string) =>
  existsSync(file) ? (readFileSync(file, 'utf8').split('\n')[0] ?? '') : '';

export interface Holder {
  child: ChildProcess;
  release: () => void;
}

/**
 * Another job holding hoth's lock: `flock` around a process that names itself in the file the
 * way a wrapper does, and then sleeps. Returns once the lock is really held, so a wrapper run
 * straight after it cannot beat it to the lock.
 */
export const holdLock = (file: string, seconds: number, holder: string): Holder => {
  writeFileSync(file, '', { mode: 0o644 });
  chmodSync(file, 0o644);
  const child = spawn(
    'flock',
    [
      '-x',
      file,
      'sh',
      '-c',
      'printf "%s\\n" "$1" >"$2"; exec sleep "$3"',
      'sh',
      holder,
      file,
      String(seconds)
    ],
    { stdio: 'ignore' }
  );
  for (let i = 0; i < 100 && !(lockHeld(file) && holderLine(file) === holder); i++) sleepMs(50);
  if (!lockHeld(file)) {
    child.kill();
    throw new Error('the stand-in holder never took the lock');
  }
  return { child, release: () => void child.kill() };
};

/** Every docker call the wrapper makes is answered, and the lock is probed on each (see probes). */
export const PROBE = `
# Is the wrapper's lock still held at this call? Asked from a new open of the file, so only a
# lock held by another open file description (the wrapper's) answers yes.
if flock -n "$FAKE_LOCK" true; then echo "$1:free" >>"$FAKE_PROBE"; else echo "$1:held" >>"$FAKE_PROBE"; fi
# And who the lock file says holds it, which is what a job waiting behind this one would print.
head -n 1 "$FAKE_LOCK" >>"$FAKE_PROBE.holder"
`;
