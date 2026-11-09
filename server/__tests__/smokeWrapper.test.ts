// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs';
import { join } from 'node:path';
import {
  hostResources,
  makeRun,
  PASS_A,
  prepare,
  root,
  setupFixtures,
  stageRoot,
  suite,
  teardownFixtures,
  tree,
  trial,
  victim,
  victimUntouched,
  wrap,
  WRAPPER
} from './smokeWrapperHarness';

/**
 * The smoke wrapper (MICA-302), against a stand-in `podman` whose console is whatever each
 * case says it is.
 *
 * `scripts/deploy/mica-smoke-release.sh` runs on the game server as the account that runs its
 * containers, and the only other time it executes is a release on `main` or an integration run
 * by hand. Two things are held here on every push.
 *
 * The verdict: a verdict that stays quiet when the suite did not finish reads as a pass, so
 * each way a run can go wrong is a case -- a FAIL line, a missing done line (stopped or
 * hung), a done line that disagrees with the lines it summarises, a scenario dropped from the
 * suite, a suite that ran nothing, a resource that broke.
 *
 * The trust: the run directory holds what a pushed zip unpacked to, so any name in it can be a
 * symlink. The wrapper must not mount from one or read one into the container, and must write
 * nothing into that directory at all. What this cannot show is a real FXServer printing real
 * lines, or real rootless containers; those are the keyed run on the box.
 *
 * Skipped where the wrapper cannot run as a trial (it needs GNU userland, `flock` and /proc),
 * with the reason printed -- and on GitHub's CI a failure instead, since a skip there would read
 * as a pass.
 */

/**
 * Every case runs the wrapper, nearly all through `spawnSync`, which blocks: Vitest cannot stop
 * one mid-run, only fail it afterwards for having taken too long, so the hang guard is `wrap`'s
 * own 60s spawn `timeout`, and Vitest's 5s default only ever failed a run that was slow and
 * fine. A run takes about 0.3s locally and 0.8-1.2s on the GitHub runner, but the third to
 * eighth cases come early in the unit step, while both Vitest projects start at once, and took
 * 3-5.5s there in every log looked at. "mounts only from its own staging copy" took 5100ms in
 * run 41685479182 and failed for it; "a keyring is fresh each run" had been given 20s on its
 * own for the same slowdown. The whole file gets that 20s, the web project's figure.
 */
describe.skipIf(!trial)('mica-smoke-release.sh', { timeout: 20_000 }, () => {
  beforeAll(setupFixtures);

  afterAll(teardownFixtures);

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
      // Nothing goes into the standalone run's database: not the zip's file, not qbx's.
      expect(r.calls).not.toMatch(/^exec -i mica-smoke-db-standalone-/m);
      expect(r.out).toContain('nothing imported');
      expect(r.cfg).toContain('set mica_integration_schema "bootstrap"');
      expect(r.cfg).toContain('set mica_integration_mode "standalone"');
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
        if (hostResources.includes(source)) continue;
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

    it('with the test clock off, the hang still waits out its timeout in real time', () => {
      const started = Date.now();
      const r = wrap(makeRun('manifest'), suite(['integration: PASS a']), {
        running: 'true',
        clock: 'real'
      });

      expect(r.status).not.toBe(0);
      expect(r.out).toContain("no 'integration: done' line within 2s");
      // The wrapper's real clock is bash's $SECONDS, which counts whole-second boundaries crossed.
      // A deadline of SECONDS+2 is therefore at least 1s of real time away, not 2: a 1s budget
      // could end a few milliseconds in, and did, under load. 1s is what it guarantees.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
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

  /**
   * Release runs 39293409481 and 39294099614 died at the database wait 5.7s after the database container started,
   * which a loop of ninety one-second tries cannot do. The image's first boot starts a temporary
   * server on the socket alone, gives root its password on it, stops it, and only then starts the
   * real one. A probe over the socket passed against the first, and the second probe the script
   * made after its loop met the gap between the two. The stand-in's timeline (FAKE_DOCKER) is
   * that sequence: "temp" answers on the socket only, "gap" answers nothing, "up" answers both.
   */
  describe('the wait for the database', () => {
    const probesIn = (calls: string) =>
      calls.split('\n').filter((line) => line.includes('-e select 1'));

    it('is not fooled by the first-boot server, which listens on no port', () => {
      const r = wrap(makeRun('none'), suite([]), {
        running: 'true',
        dbTimeline: ['temp', 'gap', 'up']
      });

      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain('did not accept a root login');
      // Refused on the first, nothing on the second, answered on the third: and the import only after.
      expect(probesIn(r.calls)).toHaveLength(3);
      expect(r.out).toContain('imported mica.esx.sql');
    });

    it('asks over TCP, every time', () => {
      const r = wrap(makeRun('none'), suite([]), {
        running: 'true',
        dbTimeline: ['temp', 'gap', 'up']
      });

      expect(probesIn(r.calls).length).toBeGreaterThan(0);
      for (const probe of probesIn(r.calls)) {
        expect(probe).toContain('-uroot -psmoke -h127.0.0.1 --protocol=tcp -e select 1');
      }
    });

    it('takes the first answer as the verdict, and does not ask a second time to decide', () => {
      // A server that answered once and would not answer again: the pass in the loop stands.
      const r = wrap(makeRun('none'), suite([]), { running: 'true', dbTimeline: ['up', 'gap'] });

      expect(r.status, r.out).toBe(0);
      expect(probesIn(r.calls)).toHaveLength(1);
      expect(r.out).toContain('imported mica.esx.sql');
    });

    it('still fails, naming the image, when no server ever accepts a login', () => {
      // The loud half: the same wait, with the database never up, must end the run and say why.
      const r = wrap(makeRun('none'), suite([]), {
        running: 'true',
        dbTimeline: Array.from({ length: 200 }, () => 'gap')
      });

      expect(r.status).toBe(1);
      expect(r.out).toContain('mariadb:noble did not accept a root login within 90s');
      expect(probesIn(r.calls)).toHaveLength(90);
      expect(r.calls).not.toMatch(/^exec -i /m);
      expect(r.calls).not.toContain('run -d -i');
    });
  });

  /**
   * MICA-315. An integration run dispatched while a deploy rebuilt the image ended at
   * "smoke: starting mariadb:noble" with exit 1 and no line saying why: `set -e` killed the
   * wrapper at a failing container call. A run that fails must say what failed.
   */
  describe('a failing step says what failed', () => {
    const NAME = 'mica-smoke-release.sh';

    it.each([
      ['the network', 'network create', 'podman network create'],
      ['the database container', 'run -d --name', 'podman run -d --name "$db"'],
      ['the FXServer container', 'run -d -i', 'podman run -d -i --name "$fx"']
    ])('names the command, the line and the status when %s cannot start', (_what, fail, shown) => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { fail });

      expect(r.status).toBe(1);
      expect(r.out).toMatch(
        new RegExp(`${NAME} FAILED at line \\d+: ${shown.replace(/\$/g, '\\$')}`)
      );
      expect(r.out).toContain('(exit status 1)');
      // podman's own words are kept, and the last line is the verdict.
      expect(r.out).toContain('Error response from daemon: stand-in failure for');
      expect(r.out.trimEnd().split('\n').pop()).toBe(
        `mica-wrapper: ${NAME} FAILED: exit status 1; the line above says why`
      );
      // The run still cleaned up after itself.
      expect(r.staged).toEqual([]);
    });

    it('ends a good run with its own line', () => {
      const ok = wrap(makeRun('manifest'), suite(PASS_A));

      expect(ok.status, ok.out).toBe(0);
      expect(ok.stdout.trimEnd().split('\n').pop()).toBe(`mica-wrapper: ${NAME} finished ok`);
    });

    it('names a failure inside a function and inside a command substitution, once', () => {
      // `count(*)` runs in `tables=$(podman exec ...)`: the substitution's shell stays quiet and
      // the shell that ran it names the assignment.
      const r = wrap(makeRun('manifest'), suite(PASS_A), { fail: 'count(*)' });

      expect(r.status).toBe(1);
      expect([...r.out.matchAll(/FAILED at line/g)]).toHaveLength(1);
      expect(r.out).toContain('tables=$(podman exec');
    });

    it('says so when a deliberate refusal ends the run, and when it is the last word', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { tables: 7 });

      expect(r.status).toBe(1);
      expect(r.out).toContain('REFUSED: [standalone mode] the database is not empty');
      expect(r.out).not.toContain('FAILED at line');
      expect(r.out.trimEnd().split('\n').pop()).toBe(
        `mica-wrapper: ${NAME} FAILED: exit status 1; the line above says why`
      );
    });

    it('says so when an unset variable ends it with no reason of its own', () => {
      // No run directory: `${1:?usage}` is bash's own message, which no step of ours wrote.
      const r = spawnSync('bash', [WRAPPER], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' }
      });

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('usage');
      expect(r.stderr).toContain(
        `${NAME} FAILED: exit status ${r.status}, and no step named a reason`
      );
    });

    it('names a signal, and still tears down what it started', async () => {
      const run = makeRun('manifest');
      const { env, calls, probe } = prepare(run, suite(PASS_A), { hang: 'run -d -i' });
      const outFile = `${run}.out`;
      const fd = openSync(outFile, 'w');
      const child = spawn('bash', [WRAPPER, run], { env, stdio: ['ignore', fd, fd] });
      const exited = new Promise<string>((resolveExit) =>
        child.on('exit', (code, signal) => resolveExit(`${code ?? signal}`))
      );
      for (let i = 0; i < 200 && !existsSync(`${calls}.hang`); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(`${calls}.hang`), 'the wrapper never reached the hung call').toBe(true);
      child.kill('SIGTERM');
      // bash runs its EXIT trap and then dies of the signal itself, so the parent sees SIGTERM.
      const how = await exited;
      closeSync(fd);
      const out = readFileSync(outFile, 'utf8');

      expect(['143', 'SIGTERM']).toContain(how);
      // Bash runs the EXIT trap with the last command's status, not the signal's: the run must
      // not be called a pass for that.
      expect(out).not.toContain('finished ok');
      expect(out).toContain(
        `${NAME} FAILED: the run ended before it finished, so it is not a pass`
      );
      expect(readFileSync(calls, 'utf8')).toMatch(/^rm -f mica-smoke-fx-/m);
      expect(readFileSync(probe, 'utf8')).not.toContain('rm:free');
      expect(existsSync(stageRoot) ? readdirSync(stageRoot) : []).toEqual([]);
    });
  });
});
