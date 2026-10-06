// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The root wrapper (MICA-302), against a stand-in `docker` whose console is whatever each
 * case says it is.
 *
 * `scripts/deploy/mica-smoke-release.sh` runs as root on the game server, and the only other
 * time it executes is a release on `main`. Two things are held here on every push.
 *
 * The verdict: a verdict that stays quiet when the suite did not finish reads as a pass, so
 * each way a run can go wrong is a case -- a FAIL line, a missing done line (stopped or
 * hung), a done line that disagrees with the lines it summarises, a scenario dropped from the
 * suite, a suite that ran nothing, a resource that broke.
 *
 * The trust: the run directory belongs to an account that runs pushed code, so any name in
 * it can be a symlink. Root must not write through one, mount from one, or read one into the
 * container, and must write nothing into that directory at all. What this cannot show is a
 * real FXServer printing real lines, or the effect of a real root-versus-gphone ownership
 * split; those are the keyed run on the box.
 *
 * Skipped, by name in the output, where the wrapper cannot run as a trial: it ignores its
 * trust-root overrides as root, and needs GNU userland, `flock` and /proc.
 */

const ROOT = resolve(__dirname, '../..');
const WRAPPER = join(ROOT, 'scripts/deploy/mica-smoke-release.sh');

const trial =
  process.platform === 'linux' &&
  process.getuid?.() !== 0 &&
  spawnSync('sh', ['-c', 'command -v flock']).status === 0 &&
  spawnSync('bash', ['--version']).status === 0;

/**
 * Records every call, and answers the few the wrapper makes. FAKE_LOGS is the console. When
 * the FXServer container is started it copies what is mounted as server-data to FAKE_SD, since
 * the wrapper removes its staging directory on the way out and the test must still see the
 * config and the keyring it built.
 */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >>"$FAKE_CALLS"
case "$1" in
    network)
        # The first thing the wrapper does after its checks: the window in which the deploy
        # account, which owns the run directory, swaps names for symlinks to the victim.
        if [ -n "$FAKE_SWAP_RUN" ] && [ "$2" = create ]; then
            mkdir -p "$FAKE_SWAP_RUN/server-data/resources/mica-keys"
            ln -s "$FAKE_VICTIM" "$FAKE_SWAP_RUN/server-data/server.cfg"
            ln -s "$FAKE_VICTIM" "$FAKE_SWAP_RUN/server-data/resources/mica-keys/fxmanifest.lua"
            ln -s "$FAKE_VICTIM" "$FAKE_SWAP_RUN/server-data/resources/mica-keys/mica-content.key"
            rm -rf "$FAKE_SWAP_RUN/resources/mica"
            ln -s "$FAKE_VICTIM_DIR" "$FAKE_SWAP_RUN/resources/mica"
        fi
        exit 0
        ;;
    image | rm) exit 0 ;;
    run)
        case "$*" in
            *" -d -i "*)
                for a in "$@"; do
                    case "$a" in
                        *:/opt/fivem/server-data) cp -a "\${a%%:*}/." "$FAKE_SD/" ;;
                    esac
                done
                ;;
        esac
        exit 0
        ;;
    logs) cat "$FAKE_LOGS" ;;
    inspect) echo "$FAKE_RUNNING" ;;
    exec)
        case "$*" in
            *"count(*)"*) echo "$FAKE_TABLES" ;;
            *"-i "*) cat >/dev/null ;;
        esac
        ;;
esac
exit 0
`;

const STARTED = 'Started resource mica\nmica started!';

/**
 * What micaOS prints when it created the schema itself on an empty database (MICA-306), which
 * is the only thing an integration run is held to say about it: the run imports nothing.
 */
const CREATED =
  "[mica] created micaOS's schema for ESX or standalone (citizenid 60 wide): 38 tables, 10 migration(s) recorded as applied.";

let dir: string;
let root: string;
let stageRoot: string;
let oxmysql: string;
let envFile: string;
let bin: string;
let victim: string;
let victimDir: string;

const VICTIM_TEXT = 'precious: not for a smoke test to touch\n';

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mica-smoke-test-')));
  root = join(dir, 'root');
  stageRoot = join(dir, 'stage');
  oxmysql = join(dir, 'oxmysql');
  envFile = join(dir, 'settings');
  bin = join(dir, 'bin');
  victim = join(dir, 'victim');
  victimDir = join(dir, 'victim-dir');
  mkdirSync(root);
  mkdirSync(oxmysql);
  mkdirSync(bin);
  writeFileSync(join(oxmysql, 'fxmanifest.lua'), '');
  writeFileSync(envFile, `LICENSE_KEY=not-a-real-key\nOXMYSQL_DIR=${oxmysql}\n`);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(victim, VICTIM_TEXT);
  mkdirSync(victimDir);
  chmodSync(victim, 0o644);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

type Kind = 'none' | 'manifest' | 'no-manifest';

/** Unpack-equivalent of a zip: mica always, mica-integration when asked. */
const makeRun = (integration: Kind) => {
  const run = join(root, `run${++counter}`);
  mkdirSync(join(run, 'resources/mica'), { recursive: true });
  writeFileSync(join(run, 'resources/mica/fxmanifest.lua'), '');
  writeFileSync(join(run, 'resources/mica/mica.esx.sql'), '-- sql\n');
  if (integration !== 'none') {
    mkdirSync(join(run, 'resources/mica-integration'));
    writeFileSync(join(run, 'resources/mica-integration/server.js'), '');
    if (integration === 'manifest') {
      writeFileSync(join(run, 'resources/mica-integration/fxmanifest.lua'), '');
    }
  }
  return run;
};

/** Every path under a directory, with its type and size: the shape of a tree, to compare. */
const tree = (path: string): string =>
  spawnSync('find', [path, '-printf', '%p %y %m\n'], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => !line.includes('expected-scenarios.txt'))
    .sort()
    .join('\n');

const idsIn = (logs: string): string[] =>
  [...logs.matchAll(/integration: PASS (\S+)/g)].map((m) => m[1]);

interface WrapOptions {
  running?: string;
  /** The scenario ids the zip was packed with. Default: the ones the console passes. */
  expected?: string[] | 'none';
  /** Swap names in the run directory for symlinks to the victim once the wrapper is under way. */
  swap?: boolean;
  /** Tables the stand-in database holds when the wrapper counts them. Default: what the mode leaves. */
  tables?: number;
}

const wrap = (
  run: string,
  logs: string,
  { running = 'false', expected, swap = false, tables }: WrapOptions = {}
) => {
  const logFile = `${run}.log`;
  const calls = `${run}.calls`;
  const sdCopy = `${run}.sd`;
  writeFileSync(logFile, logs);
  writeFileSync(calls, '');
  mkdirSync(sdCopy);
  const integ = join(run, 'resources/mica-integration');
  // An integration run starts on an empty database; a release run has just imported the file.
  const tableCount = tables ?? (existsSync(integ) ? 0 : 7);
  if (existsSync(join(integ, 'fxmanifest.lua')) && expected !== 'none') {
    writeFileSync(
      join(integ, 'expected-scenarios.txt'),
      `${(expected ?? idsIn(logs)).join('\n')}\n`
    );
  }
  const result = spawnSync('bash', [WRAPPER, run], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      MICA_SMOKE_ROOT: root,
      MICA_SMOKE_ENV: envFile,
      MICA_SMOKE_STAGE: stageRoot,
      MICA_SMOKE_LOCK: join(dir, 'lock'),
      MICA_SMOKE_SETTLE: '0',
      MICA_SMOKE_INTEGRATION_TIMEOUT: '3',
      FAKE_LOGS: logFile,
      FAKE_CALLS: calls,
      FAKE_SD: sdCopy,
      FAKE_RUNNING: running,
      FAKE_TABLES: String(tableCount),
      FAKE_SWAP_RUN: swap ? run : '',
      FAKE_VICTIM: victim,
      FAKE_VICTIM_DIR: victimDir
    },
    timeout: 60_000
  });
  const cfgPath = join(sdCopy, 'server.cfg');
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    calls: readFileSync(calls, 'utf8'),
    sd: sdCopy,
    cfg: existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '',
    keyPath: join(sdCopy, 'resources/mica-keys/mica-content.key'),
    staged: existsSync(stageRoot) ? readdirSync(stageRoot) : []
  };
};

const suite = (lines: string[], { created = true }: { created?: boolean } = {}) =>
  [STARTED, ...(created ? [CREATED] : []), ...lines].join('\n') + '\n';
const PASS_A = ['integration: PASS a', 'integration: done 1 passed 0 failed'];

const victimUntouched = () => {
  expect(readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT);
  expect(statSync(victim).mode & 0o777).toBe(0o644);
};

describe.skipIf(!trial)('mica-smoke-release.sh', () => {
  describe('integration mode', () => {
    it('passes a suite whose every scenario passed, and prints the verdict lines', () => {
      const run = makeRun('manifest');
      const r = wrap(
        run,
        suite([
          '[script:mica-integration] integration: PASS boot',
          'integration: PASS rejects-error-payload',
          'integration: done 2 passed 0 failed'
        ])
      );

      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('integration: PASS boot');
      expect(r.out).toContain('integration: PASS rejects-error-payload');
      expect(r.out).toContain('integration: done 2 passed 0 failed');
    });

    it('detects the mode from the directory: keyring, cfg lines, ensure order, read-only mounts', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      expect(readFileSync(r.keyPath, 'utf8')).toMatch(/^it1 [A-Za-z0-9+/]{43}=\n$/);
      expect(statSync(r.keyPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(r.sd, 'resources/mica-keys/fxmanifest.lua'))).toBe(true);
      expect(r.cfg).toContain(
        'set mica_content_key_file "/opt/fivem/server-data/resources/mica-keys/mica-content.key"'
      );
      expect(r.cfg).toContain('set mica_integration "1"');
      expect(r.cfg.indexOf('ensure mica\n')).toBeGreaterThan(-1);
      expect(r.cfg.indexOf('ensure mica-integration')).toBeGreaterThan(
        r.cfg.indexOf('ensure mica\n')
      );
      expect(r.calls).toMatch(
        new RegExp(
          `${stageRoot}/run\\.[A-Za-z0-9]+/src/mica-integration:/opt/fivem/server-data/resources/mica-integration:ro`
        )
      );
    });

    it('starts micaOS on an empty database: nothing is imported, and the config says why', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      expect(r.calls).not.toMatch(/^exec -i /m);
      expect(r.out).toContain('nothing imported');
      expect(r.cfg).toContain('set mica_integration_schema "bootstrap"');
    });

    it('fails when the console never says micaOS created the schema, though every scenario passed', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A, { created: false }));

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('the first-start schema is unproven');
    });

    it('refuses to start on a database that already holds tables, which would prove nothing', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { tables: 7 });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('is not empty before micaOS starts');
      expect(r.calls).not.toContain('run -d -i');
    });

    it('mounts only from its own staging copy, never from the run directory', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      expect(r.calls).not.toContain(root);
      const mounts = [...r.calls.matchAll(/-v (\S+?):\/opt\/fivem\/server-data/g)].map((m) => m[1]);
      expect(mounts.length).toBeGreaterThan(0);
      for (const source of mounts) {
        if (source === oxmysql) continue;
        expect(source.startsWith(`${stageRoot}/`), source).toBe(true);
      }
    });

    it('writes nothing into the run directory, and leaves no staging behind', () => {
      const run = makeRun('manifest');
      const before = tree(run);
      const ok = wrap(run, suite(PASS_A));

      expect(ok.status, ok.out).toBe(0);
      expect(tree(run)).toBe(before);
      expect(ok.staged).toEqual([]);

      const bad = makeRun('manifest');
      const failed = wrap(bad, suite(['integration: FAIL a: no']));

      expect(failed.status).not.toBe(0);
      expect(failed.staged).toEqual([]);
    });

    it('a keyring is fresh each run', () => {
      const a = wrap(makeRun('manifest'), suite(PASS_A));
      const b = wrap(makeRun('manifest'), suite(PASS_A));

      expect(readFileSync(a.keyPath, 'utf8')).not.toBe(readFileSync(b.keyPath, 'utf8'));
    });

    it('fails on a FAIL line, even with a done line that counts it', () => {
      const r = wrap(
        makeRun('manifest'),
        suite([
          'integration: PASS a',
          'integration: FAIL b: wrong row',
          'integration: done 1 passed 1 failed'
        ])
      );

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('integration: FAIL b: wrong row');
      expect(r.out).toContain('FAILED');
    });

    it('fails when FXServer stopped before the done line', () => {
      const r = wrap(makeRun('manifest'), suite(['integration: PASS a']), { running: 'false' });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('stopped before');
    });

    it('fails when the suite hangs, once the timeout passes', () => {
      const r = wrap(makeRun('manifest'), suite(['integration: PASS a']), { running: 'true' });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain("no 'integration: done' line within 3s");
    });

    it('fails when the done line disagrees with the lines it summarises', () => {
      const r = wrap(
        makeRun('manifest'),
        suite(['integration: PASS a', 'integration: done 2 passed 0 failed'])
      );

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('the console holds 1 PASS and 0 FAIL');
    });

    it('fails a suite that ran no scenario', () => {
      const r = wrap(makeRun('manifest'), suite(['integration: done 0 passed 0 failed']), {
        expected: ['a']
      });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('having run no scenario');
    });

    it('fails when the suite finishes twice', () => {
      const r = wrap(
        makeRun('manifest'),
        suite([...PASS_A, 'integration: done 1 passed 0 failed'])
      );

      expect(r.status).not.toBe(0);
    });

    it('fails when a scenario the zip was packed with never ran, though the run is clean', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { expected: ['a', 'b'] });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('not the scenarios this zip was packed with');
      expect(r.out).toContain('< b');
    });

    it('fails when a scenario ran that the zip was not packed with', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { expected: ['z'] });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('not the scenarios this zip was packed with');
    });

    it('refuses an integration zip with no list of expected scenarios', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { expected: 'none' });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('expected-scenarios.txt is missing');
      expect(r.calls).not.toContain('run -d');
    });

    it('fails on a script error from mica, in the shape FXServer prints one', () => {
      const r = wrap(
        makeRun('manifest'),
        suite([...PASS_A, '[script:mica] SCRIPT ERROR in mica: attempt to index a nil value'])
      );

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('a resource failed or raised a script error');
    });

    it('fails on an unhandled rejection, and on a resource that did not start', () => {
      const rejection = wrap(
        makeRun('manifest'),
        suite([...PASS_A, '[script:mica] UnhandledPromiseRejection: boom'])
      );
      const notStarted = wrap(
        makeRun('manifest'),
        suite([...PASS_A, 'Failed to start resource mica-integration'])
      );

      expect(rejection.status).not.toBe(0);
      expect(notStarted.status).not.toBe(0);
    });

    it('does not fail a deliberate refusal that prints "Error" on the mica channel', () => {
      const r = wrap(
        makeRun('manifest'),
        suite([
          '[script:mica] keygen refused: /x/mica-content.key could not be written (Error: EACCES: permission denied)',
          ...PASS_A
        ])
      );

      expect(r.status, r.out).toBe(0);
    });

    it("does not read the suite's own console lines as mica failing", () => {
      const r = wrap(
        makeRun('manifest'),
        suite([
          '[script:mica-integrat] expected error: the duplicate was refused',
          '[script:mica-integrat] integration: PASS rejects-error-payload',
          '[script:mica-integrat] integration: done 1 passed 0 failed'
        ])
      );

      expect(r.status, r.out).toBe(0);
    });

    it('judges a FAIL by the protocol line alone, whatever channel prints it', () => {
      const r = wrap(
        makeRun('manifest'),
        suite([
          '[script:mica-integrat] integration: PASS a',
          '[script:mica-integrat] integration: FAIL b: ok',
          '[script:mica-integrat] integration: done 1 passed 1 failed'
        ])
      );

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('FAILED');
    });

    it('refuses a mica-integration directory with no manifest', () => {
      const r = wrap(makeRun('no-manifest'), suite([]));

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('REFUSED');
      expect(r.calls).not.toContain('run -d');
    });
  });

  describe('a run directory the deploy account has booby-trapped', () => {
    const refused = (r: ReturnType<typeof wrap>) => {
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('REFUSED');
      expect(r.calls).not.toContain('run -d');
      victimUntouched();
    };

    it('refuses a symlinked file in mica/, and the victim stays byte-identical', () => {
      const run = makeRun('manifest');
      rmSync(join(run, 'resources/mica/fxmanifest.lua'));
      symlinkSync(victim, join(run, 'resources/mica/fxmanifest.lua'));

      refused(wrap(run, suite(PASS_A)));
    });

    it('refuses a symlinked mica/ and a symlinked resources/', () => {
      const elsewhere = join(dir, `elsewhere${counter}`);
      mkdirSync(join(elsewhere, 'mica'), { recursive: true });
      writeFileSync(join(elsewhere, 'mica/fxmanifest.lua'), '');
      writeFileSync(join(elsewhere, 'mica/mica.esx.sql'), '');

      const dirLink = makeRun('manifest');
      rmSync(join(dirLink, 'resources/mica'), { recursive: true });
      symlinkSync(join(elsewhere, 'mica'), join(dirLink, 'resources/mica'));
      refused(wrap(dirLink, suite(PASS_A)));

      const rootLink = makeRun('manifest');
      rmSync(join(rootLink, 'resources'), { recursive: true });
      symlinkSync(elsewhere, join(rootLink, 'resources'));
      refused(wrap(rootLink, suite(PASS_A)));
    });

    it('refuses a symlink inside mica-integration, and a special file', () => {
      const link = makeRun('manifest');
      symlinkSync(victim, join(link, 'resources/mica-integration/expected-scenarios.txt'));
      refused(wrap(link, suite(PASS_A), { expected: 'none' }));

      const fifo = makeRun('manifest');
      spawnSync('sh', ['-c', 'mkfifo "$1"', 'sh', join(fifo, 'resources/mica-integration/pipe')]);
      refused(wrap(fifo, suite(PASS_A)));
    });

    it('refuses a hardlinked file, which a copy into staging would otherwise read as root', () => {
      // `cp --no-preserve=all` drops the link, so this is only catchable on the source tree.
      const hard = makeRun('manifest');
      linkSync(victim, join(hard, 'resources/mica/hardlinked.txt'));
      refused(wrap(hard, suite(PASS_A)));
    });

    it('survives names swapped for symlinks after its checks, which is when root used to write through them', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A), { swap: true });

      expect(r.status, r.out).toBe(0);
      victimUntouched();
      expect(readdirSync(victimDir)).toEqual([]);
      for (const source of [...r.calls.matchAll(/-v (\S+?):\/opt\/fivem/g)].map((m) => m[1])) {
        expect(source === oxmysql || source.startsWith(`${stageRoot}/`), source).toBe(true);
      }
    });

    it('never writes through the names root used to write into, pre-placed as symlinks', () => {
      const run = makeRun('manifest');
      mkdirSync(join(run, 'server-data/resources/mica-keys'), { recursive: true });
      for (const name of ['server.cfg', 'resources/mica-keys/fxmanifest.lua']) {
        symlinkSync(victim, join(run, 'server-data', name));
      }
      symlinkSync(victim, join(run, 'server-data/resources/mica-keys/mica-content.key'));
      const before = tree(run);
      const r = wrap(run, suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      victimUntouched();
      expect(tree(run)).toBe(before);
    });
  });

  describe('plain release mode', () => {
    it('is unchanged: no keyring, no integration lines, no integration mount', () => {
      const run = makeRun('none');
      const r = wrap(run, suite([]), { running: 'true' });

      expect(r.status, r.out).toBe(0);
      expect(r.cfg).not.toContain('integration');
      expect(r.cfg).not.toContain('mica_content_key_file');
      expect(existsSync(r.keyPath)).toBe(false);
      expect(r.calls).not.toContain('mica-integration');
      expect(r.out).toContain('stayed clean');
      // The release smoke test still imports the zip's own file, and says nothing of a bootstrap.
      expect(r.calls).toMatch(/^exec -i /m);
      expect(r.cfg).not.toContain('mica_integration_schema');
      expect(r.out).toContain('imported mica.esx.sql');
      expect(r.staged).toEqual([]);
    });

    it('keeps the old scan: any error from mica after it started fails the run', () => {
      const r = wrap(makeRun('none'), suite(['[script:mica] Error: something']), {
        running: 'true'
      });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('mica logged an error');
    });

    it('does not read integration lines on the console as a verdict', () => {
      const r = wrap(makeRun('none'), suite(['integration: FAIL x: nothing']), { running: 'true' });

      expect(r.status, r.out).toBe(0);
    });

    it('still fails when FXServer is not running after mica started', () => {
      const r = wrap(makeRun('none'), suite([]), { running: 'false' });

      expect(r.status).not.toBe(0);
    });

    it('refuses a symlinked file here too, and writes nothing into the run directory', () => {
      const run = makeRun('none');
      rmSync(join(run, 'resources/mica/mica.esx.sql'));
      symlinkSync(victim, join(run, 'resources/mica/mica.esx.sql'));
      const r = wrap(run, suite([]), { running: 'true' });

      expect(r.status).not.toBe(0);
      expect(r.calls).not.toContain('run -d');
      victimUntouched();
    });
  });
});
