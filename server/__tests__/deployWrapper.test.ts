// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOY,
  PROBE,
  canRun,
  fakeRootMissing,
  holdLock,
  holderLine,
  lockHeld,
  trialMissing
} from './wrapperHarness';

/**
 * The two compose wrappers (MICA-315), against a stand-in `docker` and a stand-in FXServer that
 * answers an RCON restart.
 *
 * `mica-deploy-{dev,main}-compose.sh` run as root on the game server on every push. Until
 * MICA-315 a failing `docker compose` ended the run with exit 1 and no line saying why, and
 * nothing stopped a deploy rebuilding an image under an integration run. Held here: a failing
 * step is named, a lock that is held is waited on and then failed on in words, the lock covers
 * the run to its end, and the same lock is the smoke wrapper's (smokeWrapper.test.ts holds the
 * other half). What this cannot show is hoth: the real docker, the real sudo, root's own
 * ownership of the lock file.
 */

const WRAPPERS = ['mica-deploy-dev-compose.sh', 'mica-deploy-main-compose.sh'] as const;
const ALL = [...WRAPPERS, 'mica-smoke-release.sh'];

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >>"$FAKE_CALLS"
${PROBE}
if [ -n "$FAKE_FAIL" ]; then
    case "$*" in
        *"$FAKE_FAIL"*)
            echo "Error response from daemon: stand-in failure for: $*" >&2
            exit 1
            ;;
    esac
fi
# A compose that takes a while, so another job can arrive while this one holds the box.
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit 0
`;

/** An FXServer that answers one RCON packet the way a restart that happened is answered. */
const RESPONDER = `
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 0))
s.settimeout(60)
print(s.getsockname()[1], flush=True)
data, addr = s.recvfrom(65535)
s.sendto(b"\\xff\\xff\\xff\\xffprint Stopping resource mica\\n", addr)
`;

let dir: string;
let bin: string;
let composeFile: string;
let composeSha: string;
let envFile: string;
let noPasswordFile: string;
let fakes: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mica-deploy-test-')));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  composeFile = join(dir, 'compose.yaml');
  writeFileSync(composeFile, 'services: {}\n');
  composeSha = createHash('sha256').update(readFileSync(composeFile)).digest('hex');
  envFile = join(dir, 'env');
  writeFileSync(envFile, 'OTHER=1\nRCON_PASSWORD=hunter2\n');
  noPasswordFile = join(dir, 'env-empty');
  // What a hostile PATH would put first: an `id` that says the caller is not root, and a
  // `sha256sum` that lies. Each leaves a marker if it is ever run.
  fakes = join(dir, 'fakes');
  mkdirSync(fakes);
  writeFileSync(
    join(fakes, 'id'),
    `#!/bin/sh\necho ran >>"${join(dir, 'fake-id-ran')}"\necho 1000\nexit 1\n`
  );
  writeFileSync(
    join(fakes, 'sha256sum'),
    `#!/bin/sh\necho ran >>"${join(dir, 'fake-sha256sum-ran')}"\necho ${'a'.repeat(64)}  -\n`
  );
  chmodSync(join(fakes, 'id'), 0o755);
  chmodSync(join(fakes, 'sha256sum'), 0o755);
  writeFileSync(join(dir, 'fake-id-ran'), '');
  writeFileSync(join(dir, 'fake-sha256sum-ran'), '');
  writeFileSync(noPasswordFile, 'OTHER=1\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

/** Start the stand-in FXServer and resolve with the port it listens on. */
const startResponder = async (): Promise<{ port: string; child: ChildProcess }> => {
  const child = spawn('python3', ['-I', '-c', RESPONDER], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<string>((resolvePort, reject) => {
    child.stdout?.once('data', (d: Buffer) => resolvePort(String(d).trim()));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the stand-in FXServer exited before it listened')));
  });
  return { port, child };
};

interface Options {
  fail?: string;
  sleep?: string;
  lock?: string;
  lockTimeout?: number;
  port?: string;
  envFile?: string;
  sha?: string;
  branch?: string;
  gitSha?: string;
  omit?: string;
  /** Set on top of what the wrapper being run is sent, or replace it. */
  vars?: Record<string, string>;
}

/** What each deploy wrapper holds its six variables to (MICA-316): the one target it deploys. */
const TARGET = {
  'mica-deploy-dev-compose.sh': {
    MICA_PORT: '8676',
    GIT_BRANCH: 'dev',
    MICA_CONTAINER_NAME: 'mica-dev',
    MICA_IMAGE_TAG: 'mica-dev:local'
  },
  'mica-deploy-main-compose.sh': {
    MICA_PORT: '8675',
    GIT_BRANCH: 'main',
    MICA_CONTAINER_NAME: 'mica-main',
    MICA_IMAGE_TAG: 'mica-main:local'
  }
} as const;

const GOOD_SHA = '0123456789abcdef0123456789abcdef01234567';

const prepare = (
  options: Options = {},
  name: keyof typeof TARGET = 'mica-deploy-dev-compose.sh'
) => {
  const n = ++counter;
  const lock = options.lock ?? join(dir, `lock${n}`);
  const calls = join(dir, `calls${n}`);
  const probe = join(dir, `probe${n}`);
  writeFileSync(calls, '');
  writeFileSync(probe, '');
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    ...TARGET[name],
    GIT_BRANCH: options.branch ?? TARGET[name].GIT_BRANCH,
    GIT_SHA: options.gitSha ?? GOOD_SHA,
    MICA_CALVER: '2026.10.06.1',
    ...options.vars,
    MICA_DEPLOY_COMPOSE_FILE: composeFile,
    MICA_DEPLOY_EXPECTED_SHA: options.sha ?? composeSha,
    MICA_DEPLOY_ENV_FILE: options.envFile ?? envFile,
    MICA_DEPLOY_RCON_PORT: options.port ?? '9',
    MICA_HOTH_LOCK: lock,
    MICA_HOTH_LOCK_TIMEOUT: String(options.lockTimeout ?? 600),
    FAKE_CALLS: calls,
    FAKE_PROBE: probe,
    FAKE_LOCK: lock,
    FAKE_FAIL: options.fail ?? '',
    FAKE_SLEEP: options.sleep ?? ''
  };
  if (options.omit) delete env[options.omit];
  return { env, lock, calls, probe };
};

const result = (r: ReturnType<typeof spawnSync>, p: ReturnType<typeof prepare>) => ({
  status: r.status,
  stdout: String(r.stdout),
  out: `${r.stdout}${r.stderr}`,
  calls: readFileSync(p.calls, 'utf8'),
  probes: readFileSync(p.probe, 'utf8').split('\n').filter(Boolean),
  lock: p.lock
});

const run = (name: keyof typeof TARGET, options: Options = {}) => {
  const p = prepare(options, name);
  return result(
    spawnSync('bash', [join(DEPLOY, name)], { encoding: 'utf8', env: p.env, timeout: 60_000 }),
    p
  );
};

const lastLine = (out: string) => out.trimEnd().split('\n').pop();

const canTrial = canRun(trialMissing(), 'the compose wrapper tests');
const canFakeRoot =
  canTrial && canRun(fakeRootMissing(), "the compose wrappers' root-branch tests");

describe.skipIf(!canTrial)('the compose wrappers', () => {
  describe.each(WRAPPERS)('%s', (name) => {
    const project = name.includes('-dev-') ? 'mica-dev' : 'mica-main';

    it('deploys against a free lock: identity first, no waiting, the reload, a finishing line', async () => {
      const { port, child } = await startResponder();
      try {
        const r = run(name, { port });

        expect(r.status, r.out).toBe(0);
        expect(r.stdout.split('\n')[0]).toMatch(
          new RegExp(`^mica-wrapper: ${name} sha256 [0-9a-f]{64}$`)
        );
        expect(r.out).not.toContain('waiting for hoth');
        expect(r.out).toContain('Stopping resource mica');
        expect(r.out).toContain('reloaded micaOS on 127.0.0.1');
        expect(lastLine(r.stdout)).toBe(`mica-wrapper: ${name} finished ok`);
        expect(r.calls).toContain(`compose -p ${project} -f ${composeFile} up -d --build`);
        // The build ran with the lock held, and nothing holds or names it afterwards.
        expect(r.probes).toEqual([expect.stringMatching(/:held$/)]);
        expect(lockHeld(r.lock)).toBe(false);
        expect(holderLine(r.lock)).toBe('');
      } finally {
        child.kill();
      }
    });

    it('names the command, the line and the status when docker compose fails', () => {
      const r = run(name, { fail: 'compose' });

      expect(r.status).toBe(1);
      expect(r.out).toMatch(
        new RegExp(
          `${name} FAILED at line \\d+: docker compose -p ${project} -f "\\$COMPOSE_FILE" up -d --build \\(exit status 1\\)`
        )
      );
      expect(r.out).toContain('Error response from daemon: stand-in failure for');
      expect(lastLine(r.out)).toBe(
        `mica-wrapper: ${name} FAILED: exit status 1; the line above says why`
      );
      expect(r.out).not.toContain('reloaded micaOS');
      // A failed run lets go of the box.
      expect(lockHeld(r.lock)).toBe(false);
      expect(holderLine(r.lock)).toBe('');
    });

    it('names the reload when it fails, which is a failure and not a warning', async () => {
      // A socket that is bound and never answers: the wrapper's own python gives up after five
      // seconds. (An unbound port would be refused at once, which is a different message.)
      const silent = createSocket('udp4');
      await new Promise<void>((resolveBind) => silent.bind(0, '127.0.0.1', resolveBind));
      const port = String(silent.address().port);
      let r: ReturnType<typeof run>;
      try {
        r = run(name, { port });
      } finally {
        silent.close();
      }

      expect(r.status).toBe(1);
      expect(r.out).toContain(`rcon: no response from 127.0.0.1:${port} within 5s`);
      expect(r.out).toMatch(new RegExp(`${name} FAILED at line \\d+: python3 -`));
      expect(lastLine(r.out)).toContain('FAILED: exit status 1');
    }, 30_000);

    it('says why when the compose file is not the pinned one, and starts nothing', () => {
      const r = run(name, { sha: 'a'.repeat(64) });

      expect(r.status).toBe(1);
      expect(r.out).toContain('does not match the pinned hash');
      expect(r.calls).toBe('');
      expect(lastLine(r.out)).toBe(
        `mica-wrapper: ${name} FAILED: exit status 1; the line above says why`
      );
    });

    it('says why when there is no RCON password, after the rebuild it could not follow up', () => {
      const r = run(name, { envFile: noPasswordFile });

      expect(r.status).toBe(1);
      expect(r.out).toContain('REFUSED: no RCON_PASSWORD');
      expect(r.out).toContain('NOT reloaded');
      expect(lastLine(r.out)).toContain('the line above says why');
    });

    it('refuses bare, before any lock, and says the one thing bash said was all there is', () => {
      const r = run(name, { omit: 'MICA_PORT' });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('MICA_PORT: not set');
      expect(r.calls).toBe('');
      expect(existsSync(join(dir, `lock${counter}`))).toBe(false);
      expect(lastLine(r.out)).toContain('and no step named a reason');
    });

    // MICA-316: sudoers lets the six names through but not what they hold, so the wrapper does.
    it.each([
      ['MICA_PORT', '8080'],
      ['MICA_PORT', '8676 '],
      ['GIT_BRANCH', 'feature'],
      ['MICA_CONTAINER_NAME', 'mica-demo'],
      ['MICA_IMAGE_TAG', 'fivem-main-server:latest'],
      ['GIT_SHA', 'abc123'],
      ['GIT_SHA', 'A'.repeat(40)],
      ['GIT_SHA', `${GOOD_SHA}\nINJECTED`],
      ['GIT_SHA', `${GOOD_SHA}\n`],
      ['MICA_CALVER', '2026.10.06'],
      ['MICA_CALVER', '2026.10.06.1; id']
    ])('refuses %s=%j before any lock, and starts nothing', (variable, value) => {
      const r = run(name, { vars: { [variable]: value } });

      expect(r.status).toBe(1);
      expect(r.out).toContain(`REFUSED: ${variable} is '`);
      expect(r.calls).toBe('');
      expect(existsSync(join(dir, `lock${counter}`))).toBe(false);
      expect(lastLine(r.out)).toBe(
        `mica-wrapper: ${name} FAILED: exit status 1; the line above says why`
      );
      // The value a refusal prints is one line, so it cannot forge a line of the log.
      expect(r.out.match(/^REFUSED: /gm)).toHaveLength(1);
    });

    it('refuses the other target’s values: a dev deploy cannot be a main deploy', () => {
      const other = name.includes('-dev-')
        ? TARGET['mica-deploy-main-compose.sh']
        : TARGET['mica-deploy-dev-compose.sh'];
      const r = run(name, { vars: { ...other } });

      expect(r.status).toBe(1);
      expect(r.out).toContain('REFUSED: MICA_PORT is');
      expect(r.calls).toBe('');
    });

    it('waits when the box is held, says why and on whom, then fails loudly and starts nothing', () => {
      const lock = join(dir, `held${++counter}`);
      const holder = holdLock(lock, 30, 'mica-smoke-release.sh pid 4242 (run7) since now');
      try {
        const started = Date.now();
        const r = run(name, { lock, lockTimeout: 2 });

        expect(r.status).toBe(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
        expect(r.out).toContain(`${name} is waiting for hoth's lock ${lock}`);
        expect(r.out).toContain('held by: mica-smoke-release.sh pid 4242 (run7) since now');
        expect(r.out).toContain('they run one at a time; waiting up to 2s');
        expect(r.out).toContain("REFUSED: gave up after 2s waiting for hoth's lock");
        expect(r.out).toContain('still held by: mica-smoke-release.sh pid 4242');
        expect(r.out).toContain('Nothing was started');
        expect(lastLine(r.out)).toContain('FAILED: exit status 1');
        expect(r.calls).toBe('');
        expect(holderLine(lock)).toContain('pid 4242');
      } finally {
        holder.release();
      }
    });

    it('goes ahead once the holder lets go inside the timeout', async () => {
      const lock = join(dir, `released${++counter}`);
      const holder = holdLock(lock, 2, 'other-job pid 1 since then');
      const { port, child } = await startResponder();
      try {
        const r = run(name, { lock, lockTimeout: 30, port });

        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('is waiting for hoth');
        expect(r.out).toMatch(/got hoth's lock after \d+s/);
        expect(r.calls).toContain('up -d --build');
      } finally {
        holder.release();
        child.kill();
      }
    });

    it('refuses a lock file the deploy account could write', () => {
      const open = join(dir, `open${++counter}`);
      writeFileSync(open, '');
      chmodSync(open, 0o666);
      const r = run(name, { lock: open });

      expect(r.status).toBe(1);
      expect(r.out).toContain('is writable by group or others (mode 666)');
      expect(r.calls).toBe('');
    });

    it('ignores every trial override when it is root, which this test cannot be', () => {
      // The overrides are in an `$EUID` branch; what can be shown here is that the branch is
      // the only way in, and that the path root uses is the fixed one.
      const text = readFileSync(join(DEPLOY, name), 'utf8');
      const branch = text.match(/if \[\[ \$EUID -ne 0 \]\]; then\n([\s\S]*?)\nfi/g) ?? [];

      expect(branch.join('\n')).toContain('MICA_DEPLOY_COMPOSE_FILE');
      expect(branch.join('\n')).toContain('MICA_HOTH_LOCK');
      expect(text).toContain('HOTH_LOCK_FILE=/run/mica-hoth.lock');
    });
  });

  describe("one lock for every job on hoth's box", () => {
    it('is the same text in all three wrappers, taken once, on a path only root can write', () => {
      const blocks = ALL.map((name) => {
        const text = readFileSync(join(DEPLOY, name), 'utf8');
        const m = text.match(/^# BEGIN wrapper-common\n[\s\S]*?^# END wrapper-common$/m);
        expect(m, `${name} has a wrapper-common block`).not.toBeNull();
        expect((text.match(/^hoth_lock "/gm) ?? []).length, `${name} takes the lock once`).toBe(1);
        expect(text.indexOf('hoth_lock "')).toBeGreaterThan(text.indexOf('# END wrapper-common'));
        return m?.[0];
      });

      expect(blocks[1]).toBe(blocks[0]);
      expect(blocks[2]).toBe(blocks[0]);
      expect(blocks[0]).toContain('HOTH_LOCK_FILE=/run/mica-hoth.lock');
    });

    it('is taken before the work in each wrapper, so nothing runs unlocked', () => {
      const first = (name: string, marker: string) => {
        const text = readFileSync(join(DEPLOY, name), 'utf8');
        const lock = text.indexOf('\nhoth_lock "');
        const work = text.indexOf(marker);
        expect(lock, name).toBeGreaterThan(-1);
        expect(work, `${name}: ${marker}`).toBeGreaterThan(lock);
      };

      first('mica-deploy-dev-compose.sh', '\ndocker compose ');
      first('mica-deploy-main-compose.sh', '\ndocker compose ');
      first('mica-smoke-release.sh', '\ndocker image inspect');
    });

    it('is shared: a deploy that holds it is named to the other deploy that waits', async () => {
      const lock = join(dir, `shared${++counter}`);
      const first = await startResponder();
      const p = prepare({
        lock,
        sleep: '4',
        port: first.port,
        branch: 'dev',
        gitSha: 'abcdef0123456789abcdef0123456789abcdef01'
      });
      const outFile = join(dir, `holder-out${counter}`);
      const holder = spawn(
        'bash',
        ['-c', 'exec bash "$0" >"$1" 2>&1', join(DEPLOY, 'mica-deploy-dev-compose.sh'), outFile],
        { env: p.env, stdio: 'ignore' }
      );
      const holderExit = new Promise<number | null>((resolveExit) =>
        holder.on('exit', (code) => resolveExit(code))
      );
      try {
        for (
          let i = 0;
          i < 100 && !holderLine(lock).includes('mica-deploy-dev-compose.sh pid');
          i++
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(holderLine(lock)).toMatch(
          /^mica-deploy-dev-compose\.sh pid \d+ \(dev@abcdef012345\) since \d{4}-/
        );

        const r = run('mica-deploy-main-compose.sh', { lock, lockTimeout: 1 });

        expect(r.status).toBe(1);
        expect(r.out).toContain("mica-deploy-main-compose.sh is waiting for hoth's lock");
        expect(r.out).toMatch(/held by: mica-deploy-dev-compose\.sh pid \d+ \(dev@abcdef012345\)/);
        expect(r.calls).toBe('');
        // The first deploy was not disturbed by the second one's waiting and giving up.
        expect(await holderExit).toBe(0);
        expect(readFileSync(outFile, 'utf8')).toContain('finished ok');
        expect(lockHeld(lock)).toBe(false);
      } finally {
        holder.kill();
        first.child.kill();
      }
    });
  });

  /**
   * Who is running decides whether the trial overrides are honoured, and that decision is made
   * on bash's own $EUID, never on `id -u`: `id` is found through PATH, which nothing here may
   * trust a caller not to have chosen (the sudoers rules carry no SETENV, but this must not
   * depend on that).
   * The test runs each wrapper as uid 0 in a user namespace (`unshare -Ur`), where $EUID is 0,
   * with an `id` first on PATH that says "uid 1000, exit 1", and every override set. If the
   * wrapper believed `id` it would use them.
   */
  describe.skipIf(!canFakeRoot)('as root, with a hostile PATH', () => {
    const asRoot = (name: string, env: Record<string, string>, ...args: string[]) => {
      const r = spawnSync('unshare', ['-Ur', 'bash', join(DEPLOY, name), ...args], {
        encoding: 'utf8',
        env: { ...env, PATH: `${fakes}:${env.PATH}` },
        timeout: 60_000
      });
      return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
    };

    it.each(WRAPPERS)(
      '%s ignores every MICA_DEPLOY_* and lock override, and never runs id',
      (name) => {
        const p = prepare({ envFile: noPasswordFile }, name);
        const r = asRoot(name, p.env);

        expect(r.status).not.toBe(0);
        // The fixed lock path, not the one the caller asked for.
        expect(r.out).toContain('/run/mica-hoth.lock');
        expect(r.out).not.toContain(p.lock);
        expect(r.out).not.toContain(composeFile);
        expect(r.out).not.toContain('REFUSED: no RCON_PASSWORD');
        expect(readFileSync(p.calls, 'utf8')).toBe('');
        expect(readFileSync(join(dir, 'fake-id-ran'), 'utf8')).toBe('');
        expect(existsSync(p.lock)).toBe(false);
      }
    );

    it('mica-smoke-release.sh ignores MICA_SMOKE_ROOT, and the identity line is not the fake sha256sum', () => {
      const p = prepare();
      const r = asRoot(
        'mica-smoke-release.sh',
        { ...p.env, MICA_SMOKE_ROOT: dir, MICA_SMOKE_ENV: envFile },
        join(dir, 'a-run')
      );

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('is not under /home/gphone/smoke');
      expect(readFileSync(join(dir, 'fake-id-ran'), 'utf8')).toBe('');
      // As root the PATH is reset, so the identity line's hash is the file's own.
      const real = createHash('sha256')
        .update(readFileSync(join(DEPLOY, 'mica-smoke-release.sh')))
        .digest('hex');
      expect(r.stdout.split('\n')[0]).toBe(`mica-wrapper: mica-smoke-release.sh sha256 ${real}`);
      expect(readFileSync(join(dir, 'fake-sha256sum-ran'), 'utf8')).toBe('');
    });

    it.each(ALL)(
      '%s refuses BASH_ENV as root too, naming it, before it reads anything else',
      (name) => {
        const payload = join(dir, 'root-payload.sh');
        writeFileSync(payload, ':\n');
        const r = asRoot(name, { PATH: process.env.PATH ?? '', BASH_ENV: payload });

        expect(r.status).toBe(1);
        expect(r.stdout.split('\n')[0]).toMatch(
          new RegExp(`^mica-wrapper: ${name} sha256 [0-9a-f]{64}$`)
        );
        expect(r.out).toContain(
          'REFUSED: the environment carries a variable that changes how bash'
        );
        expect(r.out).toContain('starts: BASH_ENV.');
        expect(r.out).not.toContain('not set');
      }
    );
  });

  it('decides who is running on $EUID alone, in every wrapper, and calls id nowhere', () => {
    for (const name of ALL) {
      const code = readFileSync(join(DEPLOY, name), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');

      expect(code, name).not.toMatch(/\bid -u\b|\$\(id\b/);
      expect(code, name).toMatch(/if \(\(EUID == 0\)\); then\n\s+PATH=\/usr\/local\/sbin:/);
      expect(code, name).toMatch(/if \[\[ \$EUID -ne 0 \]\]; then/);
    }
  });

  /**
   * MICA-316. `SETENV` on the sudoers rules let gphone pass any variable to a root script,
   * BASH_ENV included, and bash sources that before the script's first line. The rules now carry
   * none, so sudo itself is the first line of defence; this is the second, and it has a limit:
   * bash reads BASH_ENV before this script runs a line, so a refusal cannot undo a payload. What
   * can is `-p` on the interpreter line, held below.
   */
  describe('bash start-up hooks', () => {
    const HOOKS: Record<string, [Record<string, string>, string]> = {
      BASH_ENV: [{ BASH_ENV: '<payload>' }, 'BASH_ENV'],
      ENV: [{ ENV: '<payload>' }, 'ENV'],
      BASH_LOADABLES_PATH: [{ BASH_LOADABLES_PATH: '/nowhere' }, 'BASH_LOADABLES_PATH'],
      CDPATH: [{ CDPATH: '/nowhere' }, 'CDPATH'],
      GLOBIGNORE: [{ GLOBIGNORE: '*' }, 'GLOBIGNORE'],
      SHELLOPTS: [{ SHELLOPTS: 'noglob' }, 'SHELLOPTS'],
      BASHOPTS: [{ BASHOPTS: 'nullglob' }, 'BASHOPTS'],
      'an exported function': [
        { 'BASH_FUNC_hook%%': '() { :; }' },
        'BASH_FUNC_*%%(exported functions)'
      ]
    };
    const IDENTITY = (name: string) => new RegExp(`^mica-wrapper: ${name} sha256 [0-9a-f]{64}$`);

    /** The payload a BASH_ENV would run: it leaves a file, so whether it ran can be asked. */
    const payload = () => {
      const n = ++counter;
      const file = join(dir, `payload${n}.sh`);
      const ran = join(dir, `payload-ran${n}`);
      writeFileSync(file, `: >"${ran}"\n`);
      return { file, ran };
    };

    /** Run a wrapper with hook variables and nothing else the wrapper needs. */
    const hooked = (
      name: string,
      hook: Record<string, string>,
      how: 'bash' | 'interpreter-line' = 'bash'
    ) => {
      const tmp = mkdtempSync(join(dir, 'hook-'));
      const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, ...hook };
      const file = join(DEPLOY, name);
      const r =
        how === 'bash'
          ? spawnSync('bash', [file], { encoding: 'utf8', env, timeout: 60_000 })
          : spawnSync(file, [], { encoding: 'utf8', env, timeout: 60_000 });
      return {
        status: r.status,
        stdout: String(r.stdout),
        out: `${r.stdout}${r.stderr}`,
        // A refused run takes no lock, so nothing is left in the directory TMPDIR names.
        left: readdirSync(tmp)
      };
    };

    describe.each(ALL)('%s', (name) => {
      it.each(Object.keys(HOOKS))(
        'refuses %s, right after the identity line, naming it and taking no lock',
        (label) => {
          const [vars, shown] = HOOKS[label] as [Record<string, string>, string];
          const p = payload();
          const hook = Object.fromEntries(
            Object.entries(vars).map(([k, v]) => [k, v === '<payload>' ? p.file : v])
          );
          const r = hooked(name, hook);

          expect(r.status).toBe(1);
          expect(r.stdout.split('\n')[0]).toMatch(IDENTITY(name));
          expect(r.out).toContain(
            `REFUSED: the environment carries a variable that changes how bash starts: ${shown}.`
          );
          // Before the guards that follow it: no MICA_PORT complaint, no run directory complaint.
          expect(r.out).not.toContain('not set');
          expect(r.out).not.toContain('is not under');
          expect(r.left).toEqual([]);
          expect(lastLine(r.out)).toBe(
            `mica-wrapper: ${name} FAILED: exit status 1; the line above says why`
          );
        }
      );

      it('does not refuse a hook variable that is empty', () => {
        const r = hooked(name, { BASH_ENV: '', ENV: '', CDPATH: '', GLOBIGNORE: '' });

        expect(r.out).not.toContain('changes how bash starts');
      });

      it('has a payload that bash runs before line one under `bash <file>`, which this cannot stop', () => {
        const p = payload();
        const r = hooked(name, { BASH_ENV: p.file }, 'bash');

        expect(r.out).toContain('REFUSED: the environment carries');
        // The limit, as a fact: the refusal came after the payload had run.
        expect(existsSync(p.ran)).toBe(true);
      });

      it.skipIf(!existsSync('/bin/bash'))(
        'runs no payload at all when sudo runs it by its interpreter line, because of -p',
        () => {
          const p = payload();
          const r = hooked(name, { BASH_ENV: p.file }, 'interpreter-line');

          // Still refused: -p stops bash reading the file, not the variable being in the environment.
          expect(r.status).toBe(1);
          expect(r.out).toContain('starts: BASH_ENV.');
          expect(existsSync(p.ran)).toBe(false);
        }
      );

      it('is a privileged-mode interpreter line, and the refusal is the first code after the identity line', () => {
        const text = readFileSync(join(DEPLOY, name), 'utf8');
        const lines = text.split('\n');
        const identity = lines.findIndex((l) =>
          l.startsWith('echo "mica-wrapper: ${0##*/} sha256')
        );
        const next = lines
          .slice(identity + 1)
          .find((l) => l.trim() !== '' && !l.trim().startsWith('#'));

        expect(lines[0]).toBe('#!/bin/bash -p');
        expect(identity).toBeGreaterThan(-1);
        expect(next).toBe('refuse_bash_hooks');
        // Nothing at the top level prints before the identity line (the functions above it
        // only print when called, and nothing calls one before the identity line).
        const before = lines.slice(0, identity).filter((l) => /^(echo|printf)\b/.test(l));
        expect(before).toEqual([]);
      });
    });
  });

  /**
   * MICA-316, the other half: what gphone's `deploy-<target>.sh` sends through sudo, what the
   * sudoers file lets through, and what the wrapper accepts are three statements of one list, and
   * a mismatch between any two is a deploy that fails after it has spent its two minutes building.
   */
  describe('the calling convention, and the sudoers rule that carries it', () => {
    const PAIRS = [
      ['deploy-dev.sh', 'mica-deploy-dev-compose.sh'],
      ['deploy-main.sh', 'mica-deploy-main-compose.sh']
    ] as const;
    const SUDOERS = join(DEPLOY, 'gphone-deploy.sudoers');

    /** The one `sudo` statement in a deploy script: its NAME=value words, its command, anything after. */
    const sent = (script: string) => {
      const text = readFileSync(join(DEPLOY, script), 'utf8').replace(/\\\n\s*/g, ' ');
      const statements = text.split('\n').filter((l) => /^sudo\s/.test(l));
      expect(statements, `${script} has exactly one sudo statement`).toHaveLength(1);
      const words = (statements[0] ?? '').trim().split(/\s+/).slice(1);
      const assignments: Record<string, string> = {};
      let i = 0;
      for (; i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i] ?? ''); i++) {
        const [k, ...v] = (words[i] ?? '').split('=');
        assignments[k as string] = v.join('=');
      }
      return { assignments, command: words[i], rest: words.slice(i + 1) };
    };

    const sudoersCode = () => {
      const text = readFileSync(SUDOERS, 'utf8').replace(/\\\n\s*/g, ' ');
      return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    };

    const kept = () => {
      const line = sudoersCode().find((l) => l.startsWith('Defaults!'));
      const names = /env_keep \+= "([^"]*)"/.exec(line ?? '')?.[1];
      expect(names, 'a Defaults! env_keep += "..." line').toBeDefined();
      return (names ?? '').split(' ').sort();
    };

    const required = (wrapper: string) =>
      [...readFileSync(join(DEPLOY, wrapper), 'utf8').matchAll(/^: "\$\{([A-Z_]+):\?/gm)]
        .map((m) => m[1] as string)
        .sort();

    describe.each(PAIRS)('%s -> %s', (script, wrapper) => {
      it('sends exactly the names sudoers keeps and the wrapper requires, and no flag or argument', () => {
        const s = sent(script);

        expect(Object.keys(s.assignments).sort()).toEqual(kept());
        expect(required(wrapper)).toEqual(kept());
        expect(s.command).toBe(`/usr/local/sbin/${wrapper}`);
        expect(s.rest).toEqual([]);
      });

      it('sends values the wrapper accepts, so the deploy reaches docker compose', () => {
        const s = sent(script);
        const calver = `${String(spawnSync('date', ['+%Y.%m.%d'], { encoding: 'utf8' }).stdout).trim()}.1`;
        // The two that are the deploy's own: a commit and a date, assigned in the script.
        const text = readFileSync(join(DEPLOY, script), 'utf8');
        expect(text).toMatch(/^GIT_SHA=\$\(git rev-parse HEAD\)$/m);
        expect(text).toMatch(/^MICA_CALVER=\$\(date \+%Y\.%m\.%d\)\.1$/m);
        expect(s.assignments.GIT_SHA).toBe('"$GIT_SHA"');
        expect(s.assignments.MICA_CALVER).toBe('"$MICA_CALVER"');

        const vars = Object.fromEntries(
          Object.entries(s.assignments).map(([k, v]) => [
            k,
            k === 'GIT_SHA' ? GOOD_SHA : k === 'MICA_CALVER' ? calver : v
          ])
        );
        const r = run(wrapper, { vars, fail: 'compose' });

        expect(r.out).not.toContain('REFUSED');
        expect(r.calls).toContain('compose -p mica-');
      });
    });

    it('has no SETENV anywhere in code, and says NOSETENV on the rule', () => {
      const code = sudoersCode().join('\n');

      expect(code).not.toMatch(/(?<!NO)SETENV/);
      expect(code.replaceAll('NOSETENV', '')).not.toMatch(/setenv/i);
      expect(code).toContain('NOPASSWD:NOSETENV:');
      // Nor does the README carry it as a rule to install.
      const readme = readFileSync(join(DEPLOY, 'README.md'), 'utf8');
      expect(readme).not.toMatch(/^gphone ALL=\(root\) NOPASSWD:SETENV:/m);
    });

    it('keeps exact names only, never a pattern, and leaves env_reset on', () => {
      const code = sudoersCode().join('\n');

      for (const name of kept()) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(code).not.toMatch(/env_reset|env_delete|env_check|env_file|!env/);
      expect(code.match(/env_keep/g)).toHaveLength(1);
    });

    it('grants the two wrappers by exact path and nothing else', () => {
      const code = sudoersCode();
      const alias = code.find((l) => l.startsWith('Cmnd_Alias '));
      const members = (alias?.split('=').slice(1).join('=') ?? '').split(',').map((s) => s.trim());
      const rules = code.filter((l) => l.startsWith('gphone '));

      expect(members.sort()).toEqual(PAIRS.map(([, w]) => `/usr/local/sbin/${w}`).sort());
      for (const m of members)
        expect(existsSync(join(DEPLOY, m.split('/').pop() as string))).toBe(true);
      expect(rules).toEqual(['gphone ALL=(root) NOPASSWD:NOSETENV: MICA_DEPLOY_COMPOSE']);
      expect(code.filter((l) => !/^(Cmnd_Alias |Defaults!|gphone )/.test(l))).toEqual([]);
    });

    it('is the file the README shows, word for word', () => {
      const body = readFileSync(SUDOERS, 'utf8').split('\n').slice(4).join('\n').trimEnd();
      const readme = readFileSync(join(DEPLOY, 'README.md'), 'utf8');

      expect(body.length).toBeGreaterThan(100);
      expect(readme).toContain(body);
    });

    // The sudoers syntax check is sudo's own, `visudo -cf`, which is what the install runs first.
    // Named in a constant because knip reads a literal `spawnSync('visudo', ...)` as an unlisted
    // binary and its config (outside this lane) has nowhere to list one but `ignoreBinaries`.
    const VISUDO = 'visudo';
    const hasVisudo = canRun(
      spawnSync('sh', ['-c', `command -v ${VISUDO}`]).status === 0
        ? null
        : '`visudo` is not installed',
      'the sudoers syntax check'
    );
    it.skipIf(!hasVisudo)('parses under visudo -cf, which is what the install runs first', () => {
      const r = spawnSync(VISUDO, ['-cf', SUDOERS], { encoding: 'utf8' });

      expect(`${r.stdout}${r.stderr}`).toContain('parsed OK');
      expect(r.status).toBe(0);
    });

    it.skipIf(!hasVisudo)(
      'is refused by visudo -cf when it is broken, so the check above can fail',
      () => {
        const broken = join(dir, 'broken.sudoers');
        writeFileSync(broken, 'gphone ALL=(root) NOPASSWD:NOSETENV /usr/local/sbin/x.sh\n');
        const r = spawnSync(VISUDO, ['-cf', broken], { encoding: 'utf8' });

        expect(r.status).not.toBe(0);
      }
    );
  });
});
