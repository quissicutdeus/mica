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
}

const prepare = (options: Options = {}) => {
  const n = ++counter;
  const lock = options.lock ?? join(dir, `lock${n}`);
  const calls = join(dir, `calls${n}`);
  const probe = join(dir, `probe${n}`);
  writeFileSync(calls, '');
  writeFileSync(probe, '');
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    MICA_PORT: '8676',
    GIT_BRANCH: options.branch ?? 'dev',
    GIT_SHA: options.gitSha ?? '0123456789abcdef0123456789abcdef01234567',
    MICA_CALVER: '2026.10.06.1',
    MICA_CONTAINER_NAME: 'mica-test',
    MICA_IMAGE_TAG: 'mica-test:local',
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

const run = (name: string, options: Options = {}) => {
  const p = prepare(options);
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
        gitSha: 'abcdef0123456789'
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
   * on bash's own $EUID, never on `id -u`: `id` is found through PATH, and the deploy wrappers
   * are reached by a sudoers rule tagged SETENV, so a caller may be able to hand over a PATH.
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
        const p = prepare({ envFile: noPasswordFile });
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
});
