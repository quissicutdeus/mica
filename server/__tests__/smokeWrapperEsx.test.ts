// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { ESX_SEED } from '../../integration/lib/esxSeed';
import {
  BRIDGE_ESX,
  BRIDGE_QBX,
  CREATED,
  dir,
  ESX_IDS,
  ESX_SQL_MARKER,
  esxCore,
  esxLib,
  esxSuite,
  hostResources,
  lastCounter,
  makeRun,
  nextCounter,
  oxInventory,
  oxLib,
  oxmysql,
  PASS_A,
  qbxSuite,
  settingsFile,
  setupFixtures,
  stageRoot,
  STARTED,
  suite,
  teardownFixtures,
  tree,
  trial,
  victim,
  victimDir,
  victimUntouched,
  wrap
} from './smokeWrapperHarness';

/**
 * The smoke wrapper's esx run (MICA-304) and the run directory a pushed zip has booby-trapped,
 * against the stand-in `podman` that `smokeWrapperHarness.ts` builds. `smokeWrapper.test.ts` says
 * what the suite as a whole holds; its cases are split over three files only so they run in
 * parallel, and each file has a scratch directory of its own.
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
   * MICA-304, the third run. The esx run is the qbx run's shape on ESX Legacy: es_extended and
   * esx_lib beside ox_inventory, esx_core's legacy.sql imported and one `users` row seeded, and
   * the console held to micaOS's bridge line for es_extended. Its schema line is the standalone
   * one (ESX and standalone share a width), so the bridge line is the only thing that tells the
   * run from a standalone one, and a case below takes it out.
   */
  describe('esx mode', () => {
    const lineOf = (r: { calls: string }, start: RegExp) =>
      r.calls.split('\n').findIndex((line) => start.test(line));

    it('starts es_extended on what it needs: esx_lib first, onesync, the inventory on esx, no mica_standalone', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const ensured = (cfg: string) => cfg.split('\n').filter((line) => line.startsWith('ensure '));
      expect(ensured(r.esxCfg)).toEqual([
        'ensure oxmysql',
        'ensure ox_lib',
        'ensure esx_lib',
        'ensure es_extended',
        'ensure ox_inventory',
        'ensure mica',
        'ensure mica-integration'
      ]);
      expect(r.esxCfg).toContain('set onesync on\n');
      expect(r.esxCfg).toContain('setr inventory:framework "esx"\n');
      expect(r.esxCfg).toContain('set mica_phone_item "phone"\n');
      expect(r.esxCfg).toContain('set mica_integration "1"\n');
      expect(r.esxCfg).toContain('set mica_integration_mode "esx"\n');
      expect(r.esxCfg).toContain('set mica_integration_schema "bootstrap"\n');
      expect(r.esxCfg).toContain('set mica_content_key_file ');
      expect(r.esxCfg).not.toContain('mica_standalone');
      // None of the qbx stack's own settings leak into it.
      expect(r.esxCfg).not.toContain('qbx');
    });

    it('mounts ox_lib, esx_lib, es_extended and ox_inventory read-only from the host, into the esx server only', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const servers = r.calls.split('\n').filter((line) => line.startsWith('run -d -i '));
      expect(servers).toHaveLength(3);
      const [standalone, , esx] = servers;
      for (const [name, source] of [
        ['ox_lib', oxLib],
        ['esx_lib', esxLib],
        ['es_extended', esxCore],
        ['ox_inventory', oxInventory]
      ]) {
        const mount = `-v ${source}:/opt/fivem/server-data/resources/${name}:ro`;
        expect(esx, name).toContain(mount);
        expect(standalone, name).not.toContain(name);
      }
      expect(esx).toContain(`-v ${oxmysql}:/opt/fivem/server-data/resources/oxmysql:ro`);
      expect(esx).not.toContain('qbx');
    });

    it("imports legacy.sql, then seeds the suite's character, into the esx database before FXServer starts", () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      const imported = r.stdin.indexOf(ESX_SQL_MARKER);
      const seeded = r.stdin.indexOf('INSERT INTO users');
      expect(imported).toBeGreaterThanOrEqual(0);
      expect(seeded).toBeGreaterThan(imported);
      expect(r.stdin).not.toContain('-- sql');
      // In the esx database only, twice (the import and the seed), and before its server starts.
      const names = [...r.calls.matchAll(/^exec -i (mica-smoke-db-\S+) /gm)].map((m) => m[1]);
      expect(names.filter((name) => name.startsWith('mica-smoke-db-esx-'))).toHaveLength(2);
      expect(lineOf(r, /^exec -i mica-smoke-db-esx-/)).toBeLessThan(
        lineOf(r, /^run -d -i --name mica-smoke-fx-esx-/)
      );
      // The character is the one the suite looks up (integration/lib/esxSeed.ts), field for field.
      const insert = r.stdin.slice(seeded);
      expect(insert).toContain(`'${ESX_SEED.identifier}'`);
      expect(insert).toContain(`'${ESX_SEED.firstname}'`);
      expect(insert).toContain(`'${ESX_SEED.lastname}'`);
      expect(insert).toContain(`'${ESX_SEED.phone}'`);
      // The columns it names are the ones micaOS's offline lookups read.
      expect(insert).toMatch(/\bfirstname\b.*\blastname\b.*\bphone_number\b/s);
      // And it is read back, with the check that no micaOS table is there to be found.
      expect(r.calls).toContain(`from users where identifier='${ESX_SEED.identifier}'`);
      expect(r.calls).toContain("like 'mica");
    });

    it('runs the esx run last, so a qbx failure is reported without waiting on it', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), {
        qbxLogs: qbxSuite(['a'], { created: false })
      });

      expect(r.status).toBe(1);
      expect(r.out).toContain('REFUSED: [qbx mode] ');
      expect(r.calls).not.toContain('mica-smoke-db-esx');
      expect(r.out).not.toContain('[esx mode] starting');
    });

    it.each([
      [
        'the console never says micaOS created its schema',
        { created: false },
        'the first-start schema is unproven'
      ],
      [
        "the console never says micaOS's bridge took es_extended",
        { bridge: false },
        "the console never said micaOS's bridge took es_extended"
      ],
      [
        'micaOS took qbx_core, not es_extended',
        { bridge: false, extra: [BRIDGE_QBX] },
        'micaOS did not detect the framework it was started beside'
      ],
      [
        'the suite never says which run it is',
        { mode: false },
        "did not say 'integration: mode esx' exactly once"
      ],
      [
        'a standalone scenario is not skipped in the esx run',
        { skips: [] },
        'the SKIP lines are not the scenarios this zip was packed to skip in the esx run'
      ],
      [
        'an esx scenario never ran',
        { passes: ['esx-one'] },
        'the PASS lines are not the scenarios this zip was packed with for the esx run'
      ],
      [
        'a scenario passes that the zip was not packed to run in esx',
        { passes: [...ESX_IDS, 'a'], skips: [] },
        'the PASS lines are not the scenarios'
      ],
      [
        'an esx scenario fails',
        { extra: ['integration: FAIL esx-one: no row'] },
        '1 integration scenario(s) FAILED'
      ],
      [
        'micaOS reports mica_standalone set beside es_extended',
        {
          extra: [
            '[FrameworkBridge] mica_standalone is set, but es_extended is running on this server.'
          ]
        },
        'micaOS reported mica_standalone set beside the framework'
      ],
      [
        'es_extended raises a script error',
        { extra: ['[script:es_extended] SCRIPT ERROR: @es_extended/server/main.lua:12: boom'] },
        'a resource failed or raised a script error'
      ]
    ])('fails the job, naming the esx run, when %s', (_what, console, reason) => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), { esxLogs: esxSuite(['a'], console) });

      expect(r.status).toBe(1);
      expect(r.out).toContain('[standalone mode] integration suite passed');
      expect(r.out).toContain('[qbx mode] integration suite passed');
      expect(r.out).toContain('REFUSED: [esx mode] ');
      expect(r.out).toContain(reason);
      expect(r.out).not.toContain('integration passed in every run');
      expect(r.out.trimEnd().split('\n').pop()).toBe(
        'mica-wrapper: mica-smoke-release.sh FAILED: exit status 1; the line above says why'
      );
      expect(r.staged).toEqual([]);
    });

    it('fails when the esx server stops before the suite is done', () => {
      const stopped = wrap(makeRun('manifest'), suite(PASS_A), {
        esxLogs: [STARTED, BRIDGE_ESX, CREATED, 'integration: mode esx'].join('\n') + '\n'
      });

      expect(stopped.status).toBe(1);
      expect(stopped.out).toContain('[esx mode] FXServer stopped before');
    });

    it('fails when the esx server hangs before the suite is done', () => {
      const hung = wrap(makeRun('manifest'), suite(PASS_A), {
        running: 'true',
        esxLogs: [STARTED, 'integration: mode esx'].join('\n') + '\n'
      });

      // `running` is one answer for every server: the standalone and qbx consoles are complete,
      // so it is the esx run that never reaches its done line, and the hang is a failure naming
      // its run.
      expect(hung.status).toBe(1);
      expect(hung.out).toContain("[esx mode] no 'integration: done' line within 3s");
    });

    it('fails when es_extended never prints mica started, naming the run and what the console said', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A), {
        esxLogs:
          'Started resource es_extended\n[script:es_extended] Failed migration boom\nQuitting: quit immediately\n'
      });

      expect(r.status).toBe(1);
      expect(r.out).toContain("[esx mode] FXServer never printed 'mica started!'");
      expect(r.out).toContain('Failed migration boom');
    });

    it('refuses an empty seed and a database that already holds micaOS tables, before the server starts', () => {
      const unseeded = wrap(makeRun('manifest'), suite(PASS_A), { esxSeeded: 0 });

      expect(unseeded.status).toBe(1);
      expect(unseeded.out).toContain('[esx mode] the suite');
      expect(unseeded.out).toContain('is not in the users table after seeding it');
      expect(unseeded.calls).not.toContain('run -d -i --name mica-smoke-fx-esx-');

      const dirty = wrap(makeRun('manifest'), suite(PASS_A), { esxTables: 3 });

      expect(dirty.status).toBe(1);
      expect(dirty.out).toContain('[esx mode] the database holds 3 micaOS table(s)');
      expect(dirty.calls).not.toContain('run -d -i --name mica-smoke-fx-esx-');
    });

    it('refuses a missing es_extended, esx_lib or legacy.sql before starting anything at all', () => {
      const missing = join(dir, 'not-there');
      const noCore = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settingsFile([`ESX_DIR=${missing}`])
      });

      expect(noCore.status).toBe(1);
      expect(noCore.out).toContain('REFUSED: ');
      expect(noCore.out).toContain(`${missing} is not a resource checkout`);
      expect(noCore.calls).not.toContain('network create');

      const noLib = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settingsFile([`ESX_LIB_DIR=${missing}`])
      });

      expect(noLib.status).toBe(1);
      expect(noLib.out).toContain(`${missing} is not a resource checkout`);
      expect(noLib.calls).not.toContain('network create');

      const noSql = wrap(makeRun('manifest'), suite(PASS_A), {
        env: settingsFile([`ESX_SQL=${join(dir, 'not-there.sql')}`])
      });

      expect(noSql.status).toBe(1);
      expect(noSql.out).toContain('not-there.sql is missing');
      expect(noSql.calls).not.toContain('network create');
    });

    // The default is a path on hoth, so this holds only where nobody installed it; on hoth the
    // wrapper's own run is the proof.
    it.skipIf(existsSync('/opt/mica-smoke/vendor/es_extended'))(
      'names the default es_extended path when none is configured and none is installed',
      () => {
        const file = join(dir, `settings-${nextCounter()}`);
        writeFileSync(file, `LICENSE_KEY=not-a-real-key\nOXMYSQL_DIR=${oxmysql}\n`);
        const r = wrap(makeRun('manifest'), suite(PASS_A), { env: file });

        expect(r.status).toBe(1);
        expect(r.out).toContain('/opt/mica-smoke/vendor/es_extended is not a resource checkout');
        expect(r.calls).not.toContain('network create');
      }
    );

    it('finds esx_lib and the SQL beside ESX_DIR unless the settings say otherwise', () => {
      const r = wrap(makeRun('manifest'), suite(PASS_A));

      expect(r.status, r.out).toBe(0);
      expect(r.calls).toContain(`-v ${esxLib}:/opt/fivem/server-data/resources/esx_lib:ro`);
      expect(r.stdin).toContain(ESX_SQL_MARKER);
    });
  });

  describe('a run directory a pushed zip has booby-trapped', () => {
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
      const elsewhere = join(dir, `elsewhere${lastCounter()}`);
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

    it('refuses a hardlinked file, which a copy into staging would otherwise hand the container', () => {
      // `cp --no-preserve=all` drops the link, so this is only catchable on the source tree.
      const hard = makeRun('manifest');
      linkSync(victim, join(hard, 'resources/mica/hardlinked.txt'));
      refused(wrap(hard, suite(PASS_A)));
    });

    it('survives names swapped for symlinks after its checks, and mounts only from its own copy', () => {
      const run = makeRun('manifest');
      const r = wrap(run, suite(PASS_A), { swap: true });

      expect(r.status, r.out).toBe(0);
      victimUntouched();
      expect(readdirSync(victimDir)).toEqual([]);
      for (const source of [...r.calls.matchAll(/-v (\S+?):\/opt\/fivem/g)].map((m) => m[1])) {
        expect(hostResources.includes(source) || source.startsWith(`${stageRoot}/`), source).toBe(
          true
        );
      }
    });

    it('never writes through names in the run directory, pre-placed as symlinks', () => {
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
});
