// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROBE, canRun, trialMissing } from './wrapperHarness';

/**
 * What the smoke wrapper's suites share (`smokeWrapper.test.ts`, `smokeWrapperQbx.test.ts`,
 * `smokeWrapperEsx.test.ts`): the stand-in `podman`, the run directories, the consoles a run can
 * print, and `wrap`, which runs the wrapper against them. Not a test file; vitest only collects
 * `*.test.ts`.
 *
 * One file of 103 cases, each a `spawnSync` of the wrapper, was the longest single thing the
 * server project ran. It is three files so Vitest gives them a worker each. A worker imports this
 * module afresh, so every file has a scratch directory and a counter of its own, and the files
 * cannot collide: `setupFixtures` and `teardownFixtures` are the `beforeAll` and `afterAll` of the
 * suite using them.
 */

export const ROOT = resolve(__dirname, '../..');
export const WRAPPER = join(ROOT, 'scripts/deploy/mica-smoke-release.sh');

export const trial = canRun(trialMissing(), 'the smoke wrapper tests');

/**
 * Records every call, and answers the few the wrapper makes. FAKE_LOGS is the console of the
 * standalone or release run's FXServer, FAKE_LOGS_QBX the qbx run's and FAKE_LOGS_ESX the esx
 * run's (told apart by the container's name, which carries the run). When an FXServer container is
 * started it copies what is mounted as server-data to FAKE_SD (FAKE_SD_QBX, FAKE_SD_ESX), since
 * the wrapper removes its staging directory on the way out and the test must still see the config
 * and the keyring it built. Everything sent to a database on stdin (the imports, the seeds) is
 * kept, in order, in $FAKE_CALLS.stdin.
 */
const FAKE_PODMAN = `#!/bin/sh
echo "$*" >>"$FAKE_CALLS"
${PROBE}
# A call the case wants to fail, the way podman does: a message on stderr and exit 1.
if [ -n "$FAKE_FAIL" ]; then
    case "$*" in
        *"$FAKE_FAIL"*)
            echo "Error response from daemon: stand-in failure for: $*" >&2
            exit 1
            ;;
    esac
fi
# A call the case wants to hang on, so a signal can arrive while the wrapper is under way.
if [ -n "$FAKE_HANG" ]; then
    case "$*" in
        *"$FAKE_HANG"*)
            echo hanging >>"$FAKE_CALLS.hang"
            sleep 30
            ;;
    esac
fi
case "$1" in
    network)
        # The first thing the wrapper does after its checks: the window in which pushed code,
        # running as the account that owns the run directory, swaps names for symlinks.
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
                dest=$FAKE_SD
                case "$*" in
                    *"--name mica-smoke-fx-qbx-"*) dest=$FAKE_SD_QBX ;;
                    *"--name mica-smoke-fx-esx-"*) dest=$FAKE_SD_ESX ;;
                esac
                for a in "$@"; do
                    case "$a" in
                        *:/opt/fivem/server-data) cp -a "\${a%%:*}/." "$dest/" ;;
                    esac
                done
                ;;
        esac
        exit 0
        ;;
    logs)
        case "$2" in
            mica-smoke-fx-qbx-*) cat "$FAKE_LOGS_QBX" ;;
            mica-smoke-fx-esx-*) cat "$FAKE_LOGS_ESX" ;;
            *) cat "$FAKE_LOGS" ;;
        esac
        ;;
    inspect) echo "$FAKE_RUNNING" ;;
    exec)
        case "$*" in
            *"-e select 1"*)
                # The wrapper's wait for the database. FAKE_DB_TIMELINE says what each probe, in the
                # order they arrive, meets: "temp" the image's first-boot server (answers on the
                # socket, listens on no port), "gap" no server at all, "up" the real one. Probes
                # past the list meet the real one, and so does every probe when it is empty.
                echo probe >>"$FAKE_CALLS.ticks"
                tick=$(($(wc -l <"$FAKE_CALLS.ticks")))
                state=up
                n=0
                for s in $FAKE_DB_TIMELINE; do
                    n=$((n + 1))
                    if [ "$n" -eq "$tick" ]; then state=$s; fi
                done
                case "$state" in
                    up) exit 0 ;;
                    temp)
                        case "$*" in
                            *"--protocol=tcp"*) exit 1 ;;
                            *) exit 0 ;;
                        esac
                        ;;
                    *) exit 1 ;;
                esac
                ;;
            *"mica-smoke-db-esx-"*)
                case "$*" in
                    *"table_name='users'"*) echo 1 ;;
                    *"from users"*) echo "$FAKE_ESX_SEEDED" ;;
                    *"like 'mica"*) echo "$FAKE_ESX_TABLES" ;;
                    *"-i "*) cat >>"$FAKE_CALLS.stdin" ;;
                esac
                ;;
            *"table_name='players'"*) echo 1 ;;
            *"from players"*) echo "$FAKE_SEEDED" ;;
            *"like 'mica"*) echo "$FAKE_QBX_TABLES" ;;
            *"count(*)"*) echo "$FAKE_TABLES" ;;
            *"-i "*) cat >>"$FAKE_CALLS.stdin" ;;
        esac
        ;;
esac
exit 0
`;

export const STARTED = 'Started resource mica\nmica started!';

/**
 * What micaOS prints when it created the schema itself on an empty database (MICA-306), which
 * is the only thing an integration run is held to say about it: the run imports nothing.
 */
export const CREATED =
  "[mica] created micaOS's schema for ESX or standalone (citizenid 60 wide): 38 tables, 10 migration(s) recorded as applied.";

/** The same, on a qbx server (MICA-304), and the bridge line micaOS prints beside qbx_core. */
export const CREATED_QBX =
  "[mica] created micaOS's schema for qbx/qb (citizenid 50 wide): 38 tables, 10 migration(s) recorded as applied.";
export const BRIDGE_QBX = 'mica: jobs -> qbx_core PlayerData.jobs + GetJob';

/** The same, on an esx server, and the bridge line micaOS prints beside es_extended. */
export const BRIDGE_ESX =
  'mica: jobs -> es_extended xPlayer.job (one job; duty only where job.onDuty is a boolean, Legacy 1.10+; esx_multijob-style resources are not read)';

/**
 * The scenarios that belong to the qbx run and to the esx run, which every other run must print a
 * SKIP line for. The ids a standalone console passes are the ones each case writes, and are
 * skipped by both.
 */
export const QBX_IDS = ['qbx-one', 'qbx-two'];
export const ESX_IDS = ['esx-one', 'esx-two'];

export const SQL_MARKER = '-- qbx_core.sql stand-in';
export const VEHICLES_MARKER = '-- vehicles.sql stand-in';
export const ESX_SQL_MARKER = '-- legacy.sql stand-in';

/** Directories of the host the wrapper mounts as they are, read-only; every other mount is staged. */
export let hostResources: string[] = [];

export let dir: string;
export let root: string;
export let stageRoot: string;
export let oxmysql: string;
export let oxLib: string;
export let qbxCore: string;
export let oxInventory: string;
export let qbxVehicles: string;
export let esxCore: string;
export let esxLib: string;
let esxSql: string;
export let envFile: string;
export let bin: string;
export let victim: string;
export let victimDir: string;

const VICTIM_TEXT = 'precious: not for a smoke test to touch\n';

/**
 * The settings file: the stand-in oxmysql and esx, the rest beside them, and `lines` after. The
 * wrapper reads the first line for a key, so a case that sets `ESX_DIR` itself replaces this one.
 */
const settingsText = (lines: string[]) =>
  [
    `LICENSE_KEY=not-a-real-key`,
    `OXMYSQL_DIR=${oxmysql}`,
    ...(lines.some((line) => line.startsWith('ESX_DIR=')) ? [] : [`ESX_DIR=${esxCore}`]),
    ...lines
  ].join('\n') + '\n';

/** A settings file of this case's own, for a case that sets the resources somewhere else. */
export const settingsFile = (lines: string[]) => {
  const file = join(dir, `settings-${++counter}`);
  writeFileSync(file, settingsText(lines));
  return file;
};

export const setupFixtures = () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mica-smoke-test-')));
  root = join(dir, 'root');
  stageRoot = join(dir, 'stage');
  oxmysql = join(dir, 'oxmysql');
  // Beside oxmysql, as on hoth: the wrapper looks for them there unless its env file says not.
  oxLib = join(dir, 'ox_lib');
  qbxCore = join(dir, 'qbx_core');
  oxInventory = join(dir, 'ox_inventory');
  qbxVehicles = join(dir, 'qbx_vehicles');
  // The esx run's resources, in a vendor directory of their own as on hoth: ESX_DIR is set in the
  // settings file, and esx_lib and the SQL are found beside it.
  esxCore = join(dir, 'es_extended');
  esxLib = join(dir, 'esx_lib');
  esxSql = join(dir, 'legacy.sql');
  envFile = join(dir, 'settings');
  bin = join(dir, 'bin');
  victim = join(dir, 'victim');
  victimDir = join(dir, 'victim-dir');
  mkdirSync(root);
  mkdirSync(bin);
  for (const resource of [oxmysql, oxLib, qbxCore, qbxVehicles, oxInventory, esxCore, esxLib]) {
    mkdirSync(resource);
    writeFileSync(join(resource, 'fxmanifest.lua'), '');
  }
  writeFileSync(join(qbxCore, 'qbx_core.sql'), `${SQL_MARKER}\n`);
  writeFileSync(join(qbxVehicles, 'vehicles.sql'), `${VEHICLES_MARKER}\n`);
  writeFileSync(esxSql, `${ESX_SQL_MARKER}\n`);
  hostResources = [oxmysql, oxLib, qbxCore, qbxVehicles, oxInventory, esxCore, esxLib];
  writeFileSync(envFile, settingsText([]));
  writeFileSync(join(bin, 'podman'), FAKE_PODMAN);
  chmodSync(join(bin, 'podman'), 0o755);
  writeFileSync(victim, VICTIM_TEXT);
  mkdirSync(victimDir);
  chmodSync(victim, 0o644);
};

/**
 * Runs `fn` with the stand-in ox_lib's fxmanifest.lua set to `manifest` and a stand-in resource
 * (an empty fxmanifest.lua) beside it for each of `present`, then puts the empty manifest back and
 * removes what it made (MICA-479). Returns the directory of each, by name.
 */
export const withOxLibManifest = <T>(manifest: string, present: string[], fn: () => T): T => {
  const manifestPath = join(oxLib, 'fxmanifest.lua');
  const made = present.map((name) => join(dir, name));
  writeFileSync(manifestPath, manifest);
  try {
    for (const path of made) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'fxmanifest.lua'), '');
    }
    return fn();
  } finally {
    writeFileSync(manifestPath, '');
    for (const path of made) rmSync(path, { recursive: true, force: true });
  }
};

export const teardownFixtures = () => {
  rmSync(dir, { recursive: true, force: true });
};

let counter = 0;

/** The next number for a name that must be new in this file's scratch directory. */
export const nextCounter = () => ++counter;

/** The number the last `makeRun` or `nextCounter` handed out, which a run's name carries. */
export const lastCounter = () => counter;

type Kind = 'none' | 'manifest' | 'no-manifest';

/** Unpack-equivalent of a zip: mica always, mica-integration when asked. */
export const makeRun = (integration: Kind) => {
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
export const tree = (path: string): string =>
  spawnSync('find', [path, '-printf', '%p %y %m\n'], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => !line.includes('expected-scenarios.txt'))
    .sort()
    .join('\n');

/** The scenarios a standalone console ran, from its PASS and FAIL lines; one if it names none. */
const idsIn = (logs: string): string[] => {
  const ids = [...logs.matchAll(/integration: (?:PASS|FAIL) ([a-z0-9-]+)/g)].map((m) => m[1]);
  return ids.length > 0 ? ids : ['a'];
};

/** The format of `expected-scenarios.txt` (scripts/pack-integration.js): every scenario, in every run. */
const expectedText = (standalone: string[], qbx: string[] = QBX_IDS, esx: string[] = ESX_IDS) =>
  [
    ...standalone.map((id) => `standalone pass ${id}`),
    ...[...qbx, ...esx].map((id) => `standalone skip ${id}`),
    ...qbx.map((id) => `qbx pass ${id}`),
    ...[...standalone, ...esx].map((id) => `qbx skip ${id}`),
    ...esx.map((id) => `esx pass ${id}`),
    ...[...standalone, ...qbx].map((id) => `esx skip ${id}`)
  ].join('\n') + '\n';

interface WrapOptions {
  /**
   * `fake` (default) runs the wrapper's waits and deadlines on its test clock (MICA_SMOKE_FAKE_CLOCK),
   * so a hang case reaches its timeout without waiting for it. `real` leaves the seam off and the
   * timeout at 2s, for the one case that proves the unset path still waits in real time.
   */
  clock?: 'fake' | 'real';
  running?: string;
  /**
   * The standalone scenario ids the zip was packed with (the qbx and esx ones are QBX_IDS and
   * ESX_IDS), or the whole text of the list, or none at all. Default: the ids the standalone
   * console runs.
   */
  expected?: string[] | 'none' | { text: string };
  /** The qbx run's console. Default: a passing one that skips what the standalone console ran. */
  qbxLogs?: string;
  /** The esx run's console. Default: a passing one that skips what the standalone console ran. */
  esxLogs?: string;
  /** Swap names in the run directory for symlinks to the victim once the wrapper is under way. */
  swap?: boolean;
  /** Tables the stand-in database holds when the wrapper counts them. Default: what the mode leaves. */
  tables?: number;
  /** micaOS tables the stand-in qbx database holds when the wrapper counts them. Default: none. */
  qbxTables?: number;
  /** What the stand-in answers when asked whether the qbx character is in `players`. Default: 1. */
  seeded?: number;
  /** micaOS tables the stand-in esx database holds when the wrapper counts them. Default: none. */
  esxTables?: number;
  /** What the stand-in answers when asked whether the esx character is in `users`. Default: 1. */
  esxSeeded?: number;
  /** The settings file. Default: one naming the stand-in oxmysql, with the rest beside it. */
  env?: string;
  /**
   * What each probe of the database wait meets, in order (see FAKE_PODMAN): "temp", "gap" or "up".
   * Default: the real server from the first probe.
   */
  dbTimeline?: string[];
  /** A podman call to fail: any call whose arguments contain this text. */
  fail?: string;
  /** A podman call to hang on for thirty seconds, so a signal can reach the wrapper mid-run. */
  hang?: string;
  /** Seconds to wait for hoth's lock before giving up. Default: far longer than any case runs. */
  lockTimeout?: number;
  /** hoth's lock file. Default: one of the case's own, so a case holds only its own lock. */
  lock?: string;
}

let lockCounter = 0;

/** Everything a run of the wrapper needs around it: the stand-in console, calls, server-data and env. */
export const prepare = (run: string, logs: string, options: WrapOptions) => {
  const { running = 'false', expected, swap = false, tables, fail = '', hang = '' } = options;
  const lock = options.lock ?? join(dir, `lock${++lockCounter}`);
  const logFile = `${run}.log`;
  const qbxLogFile = `${run}.qbx.log`;
  const esxLogFile = `${run}.esx.log`;
  const calls = `${run}.calls`;
  const probe = `${run}.probe`;
  const sdCopy = `${run}.sd`;
  const sdQbx = `${run}.sd-qbx`;
  const sdEsx = `${run}.sd-esx`;
  writeFileSync(logFile, logs);
  writeFileSync(qbxLogFile, options.qbxLogs ?? qbxSuite(idsIn(logs)));
  writeFileSync(esxLogFile, options.esxLogs ?? esxSuite(idsIn(logs)));
  writeFileSync(calls, '');
  writeFileSync(probe, '');
  mkdirSync(sdCopy);
  mkdirSync(sdQbx);
  mkdirSync(sdEsx);
  const integ = join(run, 'resources/mica-integration');
  // An integration run starts on an empty database; a release run has just imported the file.
  const tableCount = tables ?? (existsSync(integ) ? 0 : 7);
  if (existsSync(join(integ, 'fxmanifest.lua')) && expected !== 'none') {
    const text =
      typeof expected === 'object' && !Array.isArray(expected)
        ? expected.text
        : expectedText(expected ?? idsIn(logs));
    writeFileSync(join(integ, 'expected-scenarios.txt'), text);
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    MICA_SMOKE_ROOT: root,
    MICA_SMOKE_ENV: options.env ?? envFile,
    MICA_SMOKE_STAGE: stageRoot,
    MICA_HOTH_LOCK: lock,
    MICA_HOTH_LOCK_TIMEOUT: String(options.lockTimeout ?? 600),
    MICA_SMOKE_SETTLE: '0',
    MICA_SMOKE_INTEGRATION_TIMEOUT: options.clock === 'real' ? '2' : '3',
    ...(options.clock === 'real' ? {} : { MICA_SMOKE_FAKE_CLOCK: '1' }),
    FAKE_LOGS: logFile,
    FAKE_LOGS_QBX: qbxLogFile,
    FAKE_LOGS_ESX: esxLogFile,
    FAKE_CALLS: calls,
    FAKE_PROBE: probe,
    FAKE_LOCK: lock,
    FAKE_DB_TIMELINE: (options.dbTimeline ?? []).join(' '),
    FAKE_FAIL: fail,
    FAKE_HANG: hang,
    FAKE_SD: sdCopy,
    FAKE_SD_QBX: sdQbx,
    FAKE_SD_ESX: sdEsx,
    FAKE_RUNNING: running,
    FAKE_TABLES: String(tableCount),
    FAKE_QBX_TABLES: String(options.qbxTables ?? 0),
    FAKE_SEEDED: String(options.seeded ?? 1),
    FAKE_ESX_TABLES: String(options.esxTables ?? 0),
    FAKE_ESX_SEEDED: String(options.esxSeeded ?? 1),
    FAKE_SWAP_RUN: swap ? run : '',
    FAKE_VICTIM: victim,
    FAKE_VICTIM_DIR: victimDir
  };
  return { env, calls, probe, sdCopy, sdQbx, sdEsx, lock };
};

export const wrap = (run: string, logs: string, options: WrapOptions = {}) => {
  const { env, calls, probe, sdCopy, sdQbx, sdEsx, lock } = prepare(run, logs, options);
  const result = spawnSync('bash', [WRAPPER, run], { encoding: 'utf8', env, timeout: 60_000 });
  const cfgPath = join(sdCopy, 'server.cfg');
  const qbxCfgPath = join(sdQbx, 'server.cfg');
  const esxCfgPath = join(sdEsx, 'server.cfg');
  const stdinPath = `${calls}.stdin`;
  return {
    status: result.status,
    stdout: result.stdout,
    out: `${result.stdout}${result.stderr}`,
    calls: readFileSync(calls, 'utf8'),
    /** What was sent to a database on stdin, in order: the imports, then the seed. */
    stdin: existsSync(stdinPath) ? readFileSync(stdinPath, 'utf8') : '',
    probes: readFileSync(probe, 'utf8').split('\n').filter(Boolean),
    lock,
    sd: sdCopy,
    cfg: existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '',
    qbxCfg: existsSync(qbxCfgPath) ? readFileSync(qbxCfgPath, 'utf8') : '',
    esxCfg: existsSync(esxCfgPath) ? readFileSync(esxCfgPath, 'utf8') : '',
    keyPath: join(sdCopy, 'resources/mica-keys/mica-content.key'),
    qbxKeyPath: join(sdQbx, 'resources/mica-keys/mica-content.key'),
    esxKeyPath: join(sdEsx, 'resources/mica-keys/mica-content.key'),
    staged: existsSync(stageRoot) ? readdirSync(stageRoot) : []
  };
};

/** The SKIP line the suite prints, in `run`, for a scenario that belongs to `own`. */
const skipLine = (
  id: string,
  run: 'standalone' | 'qbx' | 'esx',
  own?: 'standalone' | 'qbx' | 'esx'
) =>
  `integration: SKIP ${id}: needs a ${own ?? (run === 'standalone' ? 'qbx' : 'standalone')} run, and this is the ${run} run`;

/**
 * The standalone run's console, or a release run's. The suite's own lines are as the suite prints
 * them: its mode, a SKIP for every qbx and esx scenario, then `lines`.
 */
export const suite = (
  lines: string[],
  { created = true, mode = true }: { created?: boolean; mode?: boolean } = {}
) =>
  [
    STARTED,
    ...(created ? [CREATED] : []),
    ...(mode ? ['integration: mode standalone'] : []),
    ...QBX_IDS.map((id) => skipLine(id, 'standalone', 'qbx')),
    ...ESX_IDS.map((id) => skipLine(id, 'standalone', 'esx')),
    ...lines
  ].join('\n') + '\n';

/**
 * The qbx run's console: micaOS's two lines, the suite's mode, every standalone and esx scenario
 * skipped, the qbx ones passed. Each part can be taken out to show the wrapper noticing.
 */
export const qbxSuite = (
  standalone: string[],
  {
    created = true,
    bridge = true,
    mode = true,
    skips = [...standalone, ...ESX_IDS],
    passes = QBX_IDS,
    extra = []
  }: {
    created?: boolean;
    bridge?: boolean;
    mode?: boolean;
    skips?: string[];
    passes?: string[];
    extra?: string[];
  } = {}
) =>
  [
    STARTED,
    ...(bridge ? [BRIDGE_QBX] : []),
    ...(created ? [CREATED_QBX] : []),
    ...(mode ? ['integration: mode qbx'] : []),
    ...skips.map((id) => skipLine(id, 'qbx', ESX_IDS.includes(id) ? 'esx' : 'standalone')),
    ...passes.map((id) => `integration: PASS ${id}`),
    ...extra,
    `integration: done ${passes.length} passed 0 failed`
  ].join('\n') + '\n';

/**
 * The esx run's console, the same shape: micaOS's bridge line for es_extended and its schema line
 * (the standalone one, which ESX shares), the suite's mode, every standalone and qbx scenario
 * skipped, the esx ones passed.
 */
export const esxSuite = (
  standalone: string[],
  {
    created = true,
    bridge = true,
    mode = true,
    skips = [...standalone, ...QBX_IDS],
    passes = ESX_IDS,
    extra = []
  }: {
    created?: boolean;
    bridge?: boolean;
    mode?: boolean;
    skips?: string[];
    passes?: string[];
    extra?: string[];
  } = {}
) =>
  [
    STARTED,
    ...(bridge ? [BRIDGE_ESX] : []),
    ...(created ? [CREATED] : []),
    ...(mode ? ['integration: mode esx'] : []),
    ...skips.map((id) => skipLine(id, 'esx', QBX_IDS.includes(id) ? 'qbx' : 'standalone')),
    ...passes.map((id) => `integration: PASS ${id}`),
    ...extra,
    `integration: done ${passes.length} passed 0 failed`
  ].join('\n') + '\n';

export const PASS_A = ['integration: PASS a', 'integration: done 1 passed 0 failed'];

export const victimUntouched = () => {
  expect(readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT);
  expect(statSync(victim).mode & 0o777).toBe(0o644);
};
