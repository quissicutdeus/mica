// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QBX_SEED } from '../../integration/lib/qbxSeed';
import { holdLock, holderLine, lockHeld } from './wrapperHarness';
import {
  bin,
  BRIDGE_QBX,
  CREATED,
  CREATED_QBX,
  dir,
  envFile,
  lastCounter,
  makeRun,
  nextCounter,
  oxInventory,
  oxLib,
  oxmysql,
  PASS_A,
  QBX_IDS,
  qbxCore,
  qbxSuite,
  qbxVehicles,
  root,
  ROOT,
  settingsFile,
  setupFixtures,
  SQL_MARKER,
  STARTED,
  suite,
  teardownFixtures,
  trial,
  VEHICLES_MARKER,
  withOxLibManifest,
  wrap,
  WRAPPER
} from './smokeWrapperHarness';

/**
 * The smoke wrapper's qbx run (MICA-304) and hoth's lock, against the stand-in `podman` that
 * `smokeWrapperHarness.ts` builds. `smokeWrapper.test.ts` says what the suite as a whole holds; its
 * cases are split over three files only so they run in parallel, and each file has a scratch
 * directory of its own. The lock's cases are here because they spend most of their time waiting on
 * a real `flock`, which costs a worker no CPU.
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

  /**
   * MICA-304. An integration zip is run three times by one invocation, standalone, then qbx, then
   * esx, and there is nothing to choose between them: a qbx pass that could quietly not happen
   * would be the whole of what this adds, undone. Each case below is a way it could, or a way the
   * stack could be set up wrong, and the wrapper has to say which run it was and fail. The esx
   * run's own are in the next block.
   */
  /**
   * MICA-479. ox_lib 3.42 added `require` to its manifest's dependencies and a stack without it
   * does not start: ox_lib, then qbx_core and ox_inventory, fail, and every scenario waits out its
   * own timeout. The wrapper reads the mounted manifest, so these cases write one.
   */
  describe("ox_lib's declared dependencies", () => {
    const WITH_REQUIRE = [
      "fx_version 'cerulean'",
      '-- dependencies { "commented" }',
      'dependencies {',
      "    '/server:7290',",
      "    '/onesync',",
      "    'require',",
      '}'
    ].join('\n');
    const ensured = (cfg: string) => cfg.split('\n').filter((line) => line.startsWith('ensure '));
    const mount = (name: string, source: string) =>
      `-v ${source}:/opt/fivem/server-data/resources/${name}:ro`;

    it('mounts a dependency read-only and ensures it before ox_lib, in the qbx and esx runs only', () => {
      const r = withOxLibManifest(WITH_REQUIRE, ['require'], () =>
        wrap(makeRun('manifest'), suite(PASS_A))
      );

      expect(r.status, r.out).toBe(0);
      const [standalone, qbx, esx] = r.calls.split('\n').filter((l) => l.startsWith('run -d -i '));
      expect(ensured(r.qbxCfg).slice(0, 3)).toEqual([
        'ensure oxmysql',
        'ensure require',
        'ensure ox_lib'
      ]);
      expect(ensured(r.esxCfg).slice(0, 3)).toEqual([
        'ensure oxmysql',
        'ensure require',
        'ensure ox_lib'
      ]);
      expect(ensured(r.cfg)).not.toContain('ensure require');
      expect(qbx).toContain(mount('require', join(dir, 'require')));
      expect(esx).toContain(mount('require', join(dir, 'require')));
      expect(standalone).not.toContain('require');
      // The built-ins are not resources: nothing is ensured or mounted for them.
      expect(r.qbxCfg).not.toContain('ensure /');
      expect(qbx).not.toContain('/server:7290');
    });

    it('reads `dependency` lines and a one-line list too, and a comment names nothing', () => {
      const manifest = [
        "dependency 'alpha'",
        'dependency "beta" -- dependency "gamma"',
        "dependencies { '/onesync', 'delta' }"
      ].join('\n');
      const r = withOxLibManifest(manifest, ['alpha', 'beta', 'delta'], () =>
        wrap(makeRun('manifest'), suite(PASS_A))
      );

      expect(r.status, r.out).toBe(0);
      expect(ensured(r.qbxCfg).slice(1, 5)).toEqual([
        'ensure alpha',
        'ensure beta',
        'ensure delta',
        'ensure ox_lib'
      ]);
      expect(r.qbxCfg).not.toContain('gamma');
      expect(r.qbxCfg).not.toContain('commented');
    });

    it('changes nothing for a manifest with only built-in dependencies (ox_lib 3.39)', () => {
      const r = withOxLibManifest(
        "dependencies {\n    '/server:7290',\n    '/onesync',\n}",
        [],
        () => wrap(makeRun('manifest'), suite(PASS_A))
      );

      expect(r.status, r.out).toBe(0);
      expect(ensured(r.qbxCfg)).toEqual([
        'ensure oxmysql',
        'ensure ox_lib',
        'ensure qbx_core',
        'ensure qbx_vehicles',
        'ensure ox_inventory',
        'ensure mica',
        'ensure mica-integration'
      ]);
      expect(r.out).not.toContain("ox_lib's dependency");
    });

    it('takes the directory from DEP_<NAME>_DIR in the settings file when it is set', () => {
      const elsewhere = join(dir, 'require-elsewhere');
      const env = settingsFile([`DEP_REQUIRE_DIR=${elsewhere}`]);
      const r = withOxLibManifest(WITH_REQUIRE, ['require-elsewhere'], () =>
        wrap(makeRun('manifest'), suite(PASS_A), { env })
      );

      expect(r.status, r.out).toBe(0);
      const qbx = r.calls.split('\n').filter((l) => l.startsWith('run -d -i '))[1];
      expect(qbx).toContain(mount('require', elsewhere));
    });

    it('refuses before anything starts, naming the dependency, the path and where it comes from, when it is missing', () => {
      const r = withOxLibManifest(WITH_REQUIRE, [], () => wrap(makeRun('manifest'), suite(PASS_A)));

      expect(r.status).toBe(1);
      expect(r.out).toContain("depends on the resource 'require'");
      expect(r.out).toContain(`${join(dir, 'require')}/fxmanifest.lua is not there`);
      expect(r.out).toContain('https://github.com/overextended/cfxlua-require');
      expect(r.out).toContain('DEP_REQUIRE_DIR');
      // Before the first container: not one podman call to start a database or a server.
      expect(r.calls).not.toMatch(/^run /m);
      expect(r.calls).not.toMatch(/^network create /m);
    });

    it('refuses a dependency name it would not mount', () => {
      const r = withOxLibManifest("dependencies { '../etc' }", [], () =>
        wrap(makeRun('manifest'), suite(PASS_A))
      );

      expect(r.status).toBe(1);
      expect(r.out).toContain("a dependency named '../etc'");
      expect(r.calls).not.toMatch(/^run /m);
    });

    it('fails the qbx run, with the lines, when the stack prints that a resource could not start', () => {
      const console = qbxSuite(['a'], {
        extra: [
          '[c-resources-core] Could not find dependency require for resource ox_lib.',
          "[citizen-server-impl] Couldn't start resource ox_lib."
        ]
      });
      const r = wrap(makeRun('manifest'), suite(PASS_A), { qbxLogs: console });

      expect(r.status).toBe(1);
      expect(r.out).toContain('REFUSED: [qbx mode] a resource of the qbx stack could not start');
      expect(r.out).toContain('Could not find dependency require for resource ox_lib.');
    });
  });

  describe('qbx mode', () => {
    const oneLine = (r: { calls: string }, start: RegExp) =>
      r.calls.split('\n').findIndex((line) => start.test(line));

    it('runs standalone, then qbx, then esx, each on a network, database and server of its own', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const order = [
        /^network create mica-smoke-standalone-/,
        /^run -d --name mica-smoke-db-standalone-/,
        /^run -d -i --name mica-smoke-fx-standalone-/,
        /^rm -f mica-smoke-fx-standalone-\S+ mica-smoke-db-standalone-/,
        /^network rm mica-smoke-standalone-/,
        /^network create mica-smoke-qbx-/,
        /^run -d --name mica-smoke-db-qbx-/,
        /^run -d -i --name mica-smoke-fx-qbx-/,
        /^rm -f mica-smoke-fx-qbx-\S+ mica-smoke-db-qbx-/,
        /^network rm mica-smoke-qbx-/,
        /^network create mica-smoke-esx-/,
        /^run -d --name mica-smoke-db-esx-/,
        /^run -d -i --name mica-smoke-fx-esx-/,
        /^rm -f mica-smoke-fx-esx-\S+ mica-smoke-db-esx-/,
        /^network rm mica-smoke-esx-/
      ].map((pattern) => oneLine(r, pattern));
      expect(
        order.every((at) => at >= 0),
        order.join(',')
      ).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(r.out).toContain('[standalone mode] integration suite passed');
      expect(r.out).toContain('[qbx mode] integration suite passed');
      expect(r.out).toContain('[esx mode] integration suite passed');
      expect(r.out).toContain('integration passed in every run -- standalone: 1 passed, 4 skipped');
      expect(r.out).toContain('qbx: 2 passed, 3 skipped');
      expect(r.out).toContain('esx: 2 passed, 3 skipped');
      expect(r.stdout.trimEnd().split('\n').pop()).toBe(
        'mica-wrapper: mica-smoke-release.sh finished ok'
      );
      // Each run's keyring is its own.
      expect(readFileSync(r.qbxKeyPath, 'utf8')).toMatch(/^it1 [A-Za-z0-9+/]{43}=\n$/);
      expect(readFileSync(r.qbxKeyPath, 'utf8')).not.toBe(readFileSync(r.keyPath, 'utf8'));
      expect(readFileSync(r.esxKeyPath, 'utf8')).toMatch(/^it1 [A-Za-z0-9+/]{43}=\n$/);
      expect(readFileSync(r.esxKeyPath, 'utf8')).not.toBe(readFileSync(r.qbxKeyPath, 'utf8'));
      expect(r.staged).toEqual([]);
    });

    it('starts qbx_core on what it needs: the stack in order, onesync, the inventory on qbx, no mica_standalone', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const ensured = (cfg: string) => cfg.split('\n').filter((line) => line.startsWith('ensure '));
      expect(ensured(r.qbxCfg)).toEqual([
        'ensure oxmysql',
        'ensure ox_lib',
        'ensure qbx_core',
        'ensure qbx_vehicles',
        'ensure ox_inventory',
        'ensure mica',
        'ensure mica-integration'
      ]);
      expect(r.qbxCfg).toContain('set onesync on\n');
      expect(r.qbxCfg).toContain('setr inventory:framework "qbx"\n');
      expect(r.qbxCfg).toContain('set mica_phone_item "phone"\n');
      expect(r.qbxCfg).toContain('set mica_integration "1"\n');
      expect(r.qbxCfg).toContain('set mica_integration_mode "qbx"\n');
      expect(r.qbxCfg).toContain('set mica_integration_schema "bootstrap"\n');
      expect(r.qbxCfg).toContain('set mica_content_key_file ');
      // Beside a framework the convar is a conflict, not a mode; the bridge would report it.
      expect(r.qbxCfg).not.toContain('mica_standalone');
      // And the standalone run is what it was: no framework, none of the stack.
      expect(ensured(r.cfg)).toEqual(['ensure oxmysql', 'ensure mica', 'ensure mica-integration']);
      expect(r.cfg).toContain('set mica_standalone 1\n');
      for (const absent of ['onesync', 'inventory:framework', 'mica_phone_item']) {
        expect(r.cfg).not.toContain(absent);
      }
    });

    it('mounts ox_lib, qbx_core, qbx_vehicles and ox_inventory read-only from the host, into the qbx server only', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const servers = r.calls.split('\n').filter((line) => line.startsWith('run -d -i '));
      expect(servers).toHaveLength(3);
      const [standalone, qbx] = servers;
      for (const [name, source] of [
        ['ox_lib', oxLib],
        ['qbx_core', qbxCore],
        ['qbx_vehicles', qbxVehicles],
        ['ox_inventory', oxInventory]
      ]) {
        const mount = `-v ${source}:/opt/fivem/server-data/resources/${name}:ro`;
        expect(qbx, name).toContain(mount);
        expect(standalone, name).not.toContain(name);
      }
      // The qbx run mounts none of the esx run's own.
      expect(qbx).not.toContain('es_extended');
      expect(qbx).not.toContain('esx_lib');
      expect(qbx).toContain(`-v ${oxmysql}:/opt/fivem/server-data/resources/oxmysql:ro`);
    });

    it("imports qbx_core.sql, then seeds the suite's character, into the qbx database before FXServer starts", () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      // The import, and the seed after it, in the qbx database only, and the zip's own file
      // (the release smoke test's) is not imported into either run.
      const imported = r.stdin.indexOf(SQL_MARKER);
      const seeded = r.stdin.indexOf('INSERT INTO players');
      expect(imported).toBeGreaterThanOrEqual(0);
      // qbx_vehicles' table has a foreign key onto players, so its file goes in after qbx_core's.
      const vehicles = r.stdin.indexOf(VEHICLES_MARKER);
      expect(vehicles).toBeGreaterThan(imported);
      expect(seeded).toBeGreaterThan(vehicles);
      expect(r.stdin).not.toContain('-- sql');
      const imports = [...r.calls.matchAll(/^exec -i (mica-smoke-db-\S+) /gm)].map((m) => m[1]);
      expect(imports.filter((name) => name.startsWith('mica-smoke-db-qbx-'))).toHaveLength(3);
      expect(imports.filter((name) => name.startsWith('mica-smoke-db-standalone-'))).toEqual([]);
      expect(oneLine(r, /^exec -i mica-smoke-db-qbx-/)).toBeLessThan(
        oneLine(r, /^run -d -i --name mica-smoke-fx-qbx-/)
      );
      // The character is the one the suite looks up (integration/lib/qbxSeed.ts), field for field.
      const insert = r.stdin.slice(seeded);
      expect(insert).toContain(`'${QBX_SEED.citizenid}'`);
      expect(insert).toContain(`"firstname":"${QBX_SEED.firstname}"`);
      expect(insert).toContain(`"lastname":"${QBX_SEED.lastname}"`);
      expect(insert).toContain(`"phone":"${QBX_SEED.phone}"`);
      // And it is read back, with the check that no micaOS table is there to be found.
      expect(r.calls).toContain("from players where citizenid='ITXQBX01'");
      expect(r.calls).toContain("like 'mica");
    });

    it('runs the qbx run last, so a standalone failure is reported without waiting on it', () => {
      const r = wrap(makeRun('manifest'), suite(['integration: FAIL a: no row']));

      expect(r.status).not.toBe(0);
      expect(r.out).toContain('[standalone mode]');
      expect(r.out).toContain('1 integration scenario(s) FAILED');
      expect(r.calls).not.toContain('mica-smoke-db-qbx');
      expect(r.calls).not.toContain('mica-smoke-db-esx');
      expect(r.out).not.toContain('[qbx mode] starting');
    });

    it.each([
      [
        'the console never says micaOS created its schema for qbx/qb',
        { created: false },
        'the first-start schema is unproven'
      ],
      [
        "the console never says micaOS's bridge took qbx_core",
        { bridge: false },
        'micaOS did not detect the framework it was started beside'
      ],
      [
        'the schema line is the standalone shape, not the qbx one',
        {
          created: false,
          extra: [CREATED]
        },
        'the first-start schema is unproven'
      ],
      [
        'the suite never says which run it is',
        { mode: false },
        "did not say 'integration: mode qbx' exactly once"
      ],
      [
        'a standalone scenario is not skipped in the qbx run',
        { skips: [] },
        'the SKIP lines are not the scenarios this zip was packed to skip in the qbx run'
      ],
      [
        'a qbx scenario never ran',
        { passes: ['qbx-one'] },
        'the PASS lines are not the scenarios this zip was packed with for the qbx run'
      ],
      [
        'a scenario passes that the zip was not packed to run in qbx',
        { passes: [...QBX_IDS, 'a'], skips: [] },
        'the PASS lines are not the scenarios'
      ],
      [
        'a qbx scenario fails',
        { extra: ['integration: FAIL qbx-one: no row'] },
        '1 integration scenario(s) FAILED'
      ],
      [
        'micaOS reports mica_standalone set beside qbx_core',
        {
          extra: [
            '[FrameworkBridge] mica_standalone is set, but a qb core is running on this server.'
          ]
        },
        'micaOS reported mica_standalone set beside the framework'
      ],
      [
        'qbx_core raises a script error',
        { extra: ['[script:qbx_core] SCRIPT ERROR: @qbx_core/server/main.lua:12: boom'] },
        'a resource failed or raised a script error'
      ]
    ])('fails the job, naming the qbx run, when %s', (_what, console, reason) => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { qbxLogs: qbxSuite(['a'], console) });

      expect(r.status).toBe(1);
      expect(r.out).toContain('[standalone mode] integration suite passed');
      expect(r.out).toContain('REFUSED: [qbx mode] ');
      expect(r.out).toContain(reason);
      expect(r.out).not.toContain('integration passed in every run');
      expect(r.out.trimEnd().split('\n').pop()).toBe(
        'mica-wrapper: mica-smoke-release.sh FAILED: exit status 1; the line above says why'
      );
      expect(r.staged).toEqual([]);
    });

    it('fails when the qbx server stops before the suite is done', () => {
      const stopped = wrap(makeRun('manifest'), suite(PASS_A), {
        qbxLogs: [STARTED, BRIDGE_QBX, CREATED_QBX, 'integration: mode qbx'].join('\n') + '\n'
      });

      expect(stopped.status).toBe(1);
      expect(stopped.out).toContain('[qbx mode] FXServer stopped before');
    });

    it('fails when the qbx server hangs before the suite is done', () => {
      const hung = wrap(makeRun('manifest'), suite(PASS_A), {
        running: 'true',
        qbxLogs: [STARTED, 'integration: mode qbx'].join('\n') + '\n'
      });

      // `running` is one answer for both servers: the standalone console is complete, so it
      // is the qbx run that never reaches its done line, and the hang is a failure naming its
      // run.
      expect(hung.status).toBe(1);
      expect(hung.out).toContain("[qbx mode] no 'integration: done' line within 3s");
    });

    it('fails when qbx_core never prints mica started, naming the run and what the console said', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), {
        qbxLogs:
          'Started resource qbx_core\n[script:qbx_core] OneSync Infinity is not enabled.\nQuitting: quit immediately\n'
      });

      expect(r.status).toBe(1);
      expect(r.out).toContain("[qbx mode] FXServer never printed 'mica started!'");
      expect(r.out).toContain('OneSync Infinity is not enabled');
    });

    it('refuses an empty seed and a database that already holds micaOS tables, before the server starts', () => {
      const unseeded = wrap(makeRun('manifest'), suite(PASS_A), { seeded: 0 });

      expect(unseeded.status).toBe(1);
      expect(unseeded.out).toContain('[qbx mode] the suite');
      expect(unseeded.out).toContain('is not in the players table after seeding it');
      expect(unseeded.calls).not.toContain('run -d -i --name mica-smoke-fx-qbx-');

      const dirty = wrap(makeRun('manifest'), suite(PASS_A), { qbxTables: 3 });

      expect(dirty.status).toBe(1);
      expect(dirty.out).toContain('[qbx mode] the database holds 3 micaOS table(s)');
      expect(dirty.calls).not.toContain('run -d -i --name mica-smoke-fx-qbx-');
    });

    it('refuses a missing resource or a missing qbx_core.sql before starting anything at all', () => {
      const settings = settingsFile;
      const noOxLib = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settings([`OX_LIB_DIR=${join(dir, 'not-there')}`])
      });

      expect(noOxLib.status).toBe(1);
      expect(noOxLib.out).toContain('REFUSED: ');
      expect(noOxLib.out).toContain('not-there is not a resource checkout');
      expect(noOxLib.calls).not.toContain('network create');

      const bare = join(dir, `bare${nextCounter()}`);
      mkdirSync(bare);
      writeFileSync(join(bare, 'fxmanifest.lua'), '');
      const noSql = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settings([`QBX_CORE_DIR=${bare}`])
      });

      expect(noSql.status).toBe(1);
      expect(noSql.out).toContain('qbx_core.sql is missing');
      expect(noSql.calls).not.toContain('network create');

      // qbx_vehicles: a missing checkout, and one with no vehicles.sql, both before anything starts.
      const noVehicles = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settings([`QBX_VEHICLES_DIR=${join(dir, 'no-vehicles')}`])
      });

      expect(noVehicles.status).toBe(1);
      expect(noVehicles.out).toContain('no-vehicles is not a resource checkout');
      expect(noVehicles.calls).not.toContain('network create');

      const noVehiclesSql = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settings([`QBX_VEHICLES_DIR=${bare}`])
      });

      expect(noVehiclesSql.status).toBe(1);
      expect(noVehiclesSql.out).toContain('vehicles.sql is missing');
      expect(noVehiclesSql.calls).not.toContain('network create');
    });

    it.each([
      [
        'a list in the format before the modes',
        { text: 'a\n' },
        "is not '<standalone|qbx|esx> <pass|skip> <scenario id>'"
      ],
      [
        'a list in the format before the esx run',
        { text: 'standalone pass a\nstandalone skip q\nqbx skip a\nqbx pass q\n' },
        'lists no scenario to pass in the esx run'
      ],
      [
        'a list where qbx runs nothing',
        { text: 'standalone pass a\nqbx skip a\n' },
        'lists no scenario to pass in the qbx run'
      ],
      [
        'a list where esx runs nothing',
        {
          text: 'standalone pass a\nstandalone skip q\nqbx skip a\nqbx pass q\nesx skip a\nesx skip q\n'
        },
        'lists no scenario to pass in the esx run'
      ],
      [
        'a list where the standalone and qbx runs disagree on what exists',
        { text: 'standalone pass a\nstandalone skip q\nqbx pass q\nesx pass q\nesx skip a\n' },
        'lists different scenarios for the standalone and qbx runs'
      ],
      [
        'a list where the standalone and esx runs disagree on what exists',
        {
          text: 'standalone pass a\nstandalone skip q\nqbx skip a\nqbx pass q\nesx pass a\n'
        },
        'lists different scenarios for the standalone and esx runs'
      ],
      [
        'a list that names a scenario twice',
        {
          text: 'standalone pass a\nstandalone pass a\nstandalone skip q\nqbx pass q\nqbx skip a\nqbx skip a\n'
        },
        'lists a scenario twice in the standalone run'
      ]
    ])('refuses %s, before starting anything', (_what, expected, reason) => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { expected });

      expect(r.status).toBe(1);
      expect(r.out).toContain(reason);
      expect(r.calls).not.toContain('network create');
    });

    it('prints every line the two workflows require of a passing run, and only a full run prints them all', () => {
      const required = ['integration.yml', 'release.yml'].map((name) => {
        const text = readFileSync(join(ROOT, '.github/workflows', name), 'utf8');
        const block = text.match(/RUN_CHECKED_REQUIRE: \|\n((?: {12}\S.*\n)+)/);
        expect(block, `${name} sets no RUN_CHECKED_REQUIRE`).not.toBeNull();
        return (block?.[1] ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      });
      expect(required[1]).toEqual(required[0]);
      expect(required[0].length).toBeGreaterThanOrEqual(4);
      // Each mode's own pass line is required, so a wrapper edited to leave a run out is red in CI.
      for (const mode of ['standalone', 'qbx', 'esx']) {
        expect(required[0], mode).toContain(`[${mode} mode] integration suite passed`);
      }

      const good = wrap(makeRun('manifest'), suite(PASS_A));
      expect(good.status, good.out).toBe(0);
      for (const line of required[0]) expect(good.out, line).toContain(line);

      // A run that fails in either mode prints no "passed in every run" line, and the one for
      // the mode that failed is missing too.
      const bad = wrap(makeRun('manifest'), suite(PASS_A), {
        qbxLogs: qbxSuite(['a'], { created: false })
      });
      expect(bad.out).not.toContain('integration passed in every run');
      expect(bad.out).not.toContain('[qbx mode] integration suite passed');
    });

    it('leaves the plain release smoke test as one run, with none of the qbx stack', () => {
      const r = wrap(makeRun('none'), suite([]), { running: 'true' });

      expect(r.status, r.out).toBe(0);
      expect(r.calls).not.toContain('qbx');
      expect(r.calls).not.toContain('es_extended');
      expect(r.calls).not.toContain('mica-smoke-db-standalone');
      expect(r.calls.match(/^run -d -i /gm)).toHaveLength(1);
      expect(r.cfg).not.toContain('onesync');
      expect(r.cfg).not.toContain('ox_lib');
    });
  });

  /**
   * MICA-315. A dev deploy rebuilds the image an integration run starts its container from, and
   * the two shared the box with nothing between them. They now take one lock, hoth's, which a
   * job that finds it held says it is waiting on, and gives up on loudly.
   */
  describe("hoth's lock", () => {
    it('is free: no waiting, the whole run is under it, and it is empty and free afterwards', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain('waiting for hoth');
      // Every podman call, the teardown's included, ran with the lock held.
      expect(r.probes.length).toBeGreaterThan(5);
      expect(r.probes.filter((p) => p.endsWith(':free'))).toEqual([]);
      expect(r.probes.some((p) => p === 'rm:held')).toBe(true);
      expect(lockHeld(r.lock)).toBe(false);
      expect(holderLine(r.lock)).toBe('');
    });

    it('names itself in the lock file while it holds it, and a failed run releases it too', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A), { fail: 'run -d -i' });

      expect(r.status).toBe(1);
      // What a waiting job would have read, as the stand-in podman read it mid-run.
      const named = readFileSync(`${run}.probe.holder`, 'utf8').split('\n').filter(Boolean);
      expect(named.length).toBeGreaterThan(0);
      for (const line of named) {
        expect(line).toMatch(
          new RegExp(`^mica-smoke-release\\.sh pid \\d+ \\(run${lastCounter()}\\) since \\d{4}-`)
        );
      }
      expect(lockHeld(r.lock)).toBe(false);
      expect(holderLine(r.lock)).toBe('');
    });

    it('waits when it is held, says why and on whom, and starts nothing after the timeout', () => {
      const lock = join(dir, `held${nextCounter()}`);
      const holder = holdLock(lock, 30, 'mica-deploy.sh dev pid 4242 since now');
      try {
        // One second is the shortest wait `flock -w` takes in whole seconds, and the holder has the
        // lock for thirty, so the wrapper reaches its timeout whatever the load.
        const seconds = 1;
        const started = Date.now();
        const r = wrap(makeRun('manifest'), suite(PASS_A), { lock, lockTimeout: seconds });

        expect(r.status).toBe(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(seconds * 1000 - 100);
        expect(r.out).toContain("mica-smoke-release.sh is waiting for hoth's lock");
        expect(r.out).toContain('held by: mica-deploy.sh dev pid 4242 since now');
        expect(r.out).toContain(`waiting up to ${seconds}s`);
        expect(r.out).toContain(`REFUSED: gave up after ${seconds}s waiting for hoth's lock`);
        expect(r.out).toContain('still held by: mica-deploy.sh dev pid 4242');
        expect(r.out).toContain('Nothing was started');
        expect(r.out.trimEnd().split('\n').pop()).toContain('FAILED: exit status 1');
        // Not one podman call: the image check waits behind the lock too.
        expect(r.calls).toBe('');
        // And it did not clear the name of a holder that is still running.
        expect(holderLine(lock)).toContain('pid 4242');
      } finally {
        holder.release();
      }
    });

    it('goes ahead once the holder lets go inside the timeout', () => {
      const lock = join(dir, `released${nextCounter()}`);
      const holder = holdLock(lock, 2, 'other-job pid 1 since then');
      try {
        const r = wrap(makeRun('manifest'), suite(PASS_A), { lock, lockTimeout: 30 });

        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('is waiting for hoth');
        expect(r.out).toMatch(/got hoth's lock after \d+s/);
        expect(r.calls).toContain('network create');
      } finally {
        holder.release();
      }
    });

    it('refuses a lock file another account could write, and one that is a link', () => {
      const open = join(dir, `open${nextCounter()}`);
      writeFileSync(open, '');
      chmodSync(open, 0o666);
      const writable = wrap(makeRun('manifest'), suite(PASS_A), { lock: open });

      expect(writable.status).toBe(1);
      expect(writable.out).toContain('is writable by group or others (mode 666)');
      expect(writable.calls).toBe('');

      const target = join(dir, `target${nextCounter()}`);
      writeFileSync(target, '');
      const link = join(dir, `link${nextCounter()}`);
      symlinkSync(target, link);
      const linked = wrap(makeRun('manifest'), suite(PASS_A), { lock: link });

      expect(linked.status).toBe(1);
      expect(linked.out).toContain('is a symlink');
      expect(linked.calls).toBe('');
    });

    it('is taken after the run directory is checked, so a misuse is refused at once, not queued', () => {
      const lock = join(dir, `misuse${nextCounter()}`);
      const holder = holdLock(lock, 30, 'other-job pid 1 since then');
      try {
        const started = Date.now();
        const r = spawnSync('bash', [WRAPPER, join(dir, 'not-under-the-root')], {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            MICA_SMOKE_ROOT: root,
            MICA_SMOKE_ENV: envFile,
            MICA_HOTH_LOCK: lock,
            MICA_HOTH_LOCK_TIMEOUT: '20'
          },
          timeout: 15_000
        });

        expect(r.status).toBe(1);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(`${r.stdout}${r.stderr}`).toContain('is not under');
      } finally {
        holder.release();
      }
    });
  });
});
