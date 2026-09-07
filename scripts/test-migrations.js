// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import mysql from 'mysql2/promise';

/**
 * Run the versioned migrations against a real MariaDB, in a throwaway container.
 *
 * **Opt-in — `pnpm test:migrations`, deliberately not part of `pnpm verify`.** It needs
 * Docker and pulls an image, which is not a cost every gate should carry. Revisit that
 * separately; the point of leaving it out is that `verify` stays runnable anywhere.
 *
 * ## Why this exists
 *
 * `server/__tests__/` mocks `Database`, so a migration suite there can only assert SQL text
 * and call ordering. That is a real check, and it is blind to everything MySQL decides:
 * whether a statement parses, whether an `ALTER` succeeds against the rows actually present,
 * whether a constraint rejects what it should. MICA-153 shipped a draft whose every mocked
 * assertion passed and which aborted half-way through `ADD UNIQUE KEY` with ER 1062 on the
 * first database that had the duplicates it was written to remove.
 *
 * ## What it refuses to do
 *
 * **It drives the real module.** It imports `server/migrations` and calls the real
 * `runPendingMigrations`, with `exports.oxmysql` stubbed by an actual client, so the ledger,
 * the apply ordering, the `information_schema` guards and the id-to-filename contract are all
 * exercised as they run on a server. Extracting the SQL and running it in a shell tests a
 * transcription of the migration rather than the migration, which is the failure mode this
 * file is a reaction to — it would automate what a person can already do by hand and prove
 * nothing new.
 *
 * **A skip is never a pass.** Every path that cannot complete the work exits non-zero and
 * says so. There is no "Docker missing, nothing to do here" branch, because a green line
 * from a run that tested nothing is worse than no harness: somebody would trust it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const IMAGE = 'mariadb:11';
const CONTAINER_LABEL = 'mica-migration-harness';
const ROOT_PASSWORD = 'mica-throwaway';
/** How long to wait for the server to accept connections, in ms. */
const READY_TIMEOUT = 90_000;

/**
 * Accept an already-running database from the environment, avoiding Docker startup.
 * All four are required together; if any is set, all must be provided.
 */
const DB_HOST = process.env.MICA_DB_HOST;
const DB_PORT = process.env.MICA_DB_PORT;
const DB_USER = process.env.MICA_DB_USER;
const DB_PASSWORD = process.env.MICA_DB_PASSWORD;
const EXTERNAL_DB = Boolean(DB_HOST || DB_PORT || DB_USER || DB_PASSWORD);

/**
 * Assertions are counted, and the run fails if too few of them happened.
 *
 * The same reasoning as `changelog.test.ts`'s "the check fires, rather than merely being
 * configured": a harness that returns early — a fixture that silently seeded nothing, a loop
 * over an empty list — would otherwise print a pass having checked almost nothing.
 *
 * The run currently makes **115** checks — the two `runVariant`s (17 each), the two
 * `runSweepFixtures` (17 each) and the two `runNumberMigration`s (MICA-284; 21 on qb, 16 on
 * ESX) — so the margin here is eight. That is deliberately tight: losing any one fixture
 * drops below it and fails, which is the whole point. Raise the floor when you add checks,
 * rather than letting the gap widen until it stops catching anything.
 */
const MINIMUM_CHECKS = 107;
let checksRun = 0;

const check = (label, actual, expected) => {
  checksRun += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n    expected: ${e}\n    actual:   ${a}`);
  console.log(`    ok  ${label}`);
};

const step = (message) => console.log(`\n== ${message}`);

/* ------------------------------------------------------------------ docker */

const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();

/**
 * Fail before anything else if Docker cannot be used, naming which half is missing.
 *
 * `docker info` rather than `docker --version`: the binary being installed says nothing
 * about the daemon being reachable, and "command exists" is exactly the kind of check that
 * passes while the thing it stands for is unavailable.
 */
const assertDockerUsable = () => {
  try {
    docker(['--version']);
  } catch {
    throw new Error(
      'docker is not on PATH. This harness needs it — install Docker, or run this on a ' +
        'machine that has it. Nothing was tested.'
    );
  }

  try {
    docker(['info']);
  } catch {
    throw new Error(
      'the docker daemon is not reachable (`docker info` failed). Start Docker and try ' +
        'again. Nothing was tested.'
    );
  }
};

const startContainer = () => {
  step(`starting ${IMAGE}`);
  // Any free host port: a fixed one collides with whatever else is running, and that would
  // be an environment failure wearing the mask of a test failure.
  const id = docker([
    'run',
    '--detach',
    '--rm',
    '--label',
    CONTAINER_LABEL,
    '--env',
    `MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    '--publish',
    '127.0.0.1::3306',
    IMAGE
  ]);

  const mapping = docker(['port', id, '3306/tcp']);
  const port = Number(mapping.split('\n')[0].split(':').pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read the published port from \`docker port\`: ${mapping}`);
  }
  console.log(`    container ${id.slice(0, 12)} on 127.0.0.1:${port}`);
  return { id, port };
};

const stopContainer = (id) => {
  try {
    docker(['stop', '--time', '2', id]);
  } catch {
    console.error(`    warning: could not stop container ${id.slice(0, 12)}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectWhenReady = async (port) => {
  step('waiting for the server to accept connections');
  const deadline = Date.now() + READY_TIMEOUT;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: ROOT_PASSWORD,
        multipleStatements: true
      });
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(
    `the database never became reachable within ${READY_TIMEOUT / 1000}s: ${lastError?.message}`
  );
};

/* ------------------------------------- the oxmysql shim, and the real module */

/**
 * `Database` reads `exports.oxmysql` through a getter, so a real client put here before the
 * bundle is imported is what every migration statement actually runs through.
 *
 * FiveM's `exports` is both callable and indexable, so a function carrying a property is the
 * faithful shape — the same reasoning as the stub in `scripts/generate-sql.js`.
 */
const installOxmysql = (connection) => {
  const oxmysql = {
    query_async: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return rows;
    },
    insert_async: async (sql, params = []) => {
      const [result] = await connection.query(sql, params);
      return result.insertId;
    },
    update_async: async (sql, params = []) => {
      const [result] = await connection.query(sql, params);
      return result.affectedRows;
    },
    scalar_async: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return Object.values(rows[0])[0];
    },
    single_async: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }
  };

  const exportsFn = function () {};
  exportsFn.oxmysql = oxmysql;
  globalThis.exports = exportsFn;
};

/**
 * Bundle and import the real server modules.
 *
 * The banner stubs only the FiveM globals that are genuinely absent, and each with `??`, so
 * the `exports` installed above survives. Overwriting it here is the one mistake that would
 * quietly turn this whole harness back into a mock.
 */
const loadServerModule = async () => {
  const entry = [
    `export { runPendingMigrations, reportPendingMigrations } from '${root}/server/lib/migrations.ts';`,
    `export { migrations } from '${root}/server/migrations/index.ts';`,
    // MICA-152. The services barrel is what fills `declaredServices`, and the sweep
    // derives its table set from it — so importing it is the only way to drive the real
    // derivation rather than a list retyped here.
    `import '${root}/server/services/index.ts';`,
    `export { sweepOrphanedRows, purgeOwnedRows, ownedTables } from '${root}/server/lib/orphanSweep.ts';`,
    `export { __setResourceLookup, detectFramework, FrameworkBridge } from '${root}/server/lib/FrameworkBridge.ts';`,
    // MICA-284. The additive planner, so a migration can be held to "leaves the table in the
    // declared shape": a fresh install and an upgraded one must not be able to disagree.
    `export { SchemaMigrator } from '${root}/server/lib/SchemaMigrator.ts';`
  ].join('\n');

  const outfile = path.join(root, 'node_modules', '.cache', 'mica-migration-harness.mjs');
  await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: [
        'globalThis.exports = globalThis.exports ?? function () {};',
        'globalThis.onNet = globalThis.onNet ?? (() => {});',
        'globalThis.emitNet = globalThis.emitNet ?? (() => {});',
        'globalThis.on = globalThis.on ?? (() => {});',
        'globalThis.source = globalThis.source ?? 0;',
        "globalThis.GetCurrentResourceName = globalThis.GetCurrentResourceName ?? (() => 'mica');",
        'globalThis.RegisterCommand = globalThis.RegisterCommand ?? (() => {});',
        'globalThis.IsPlayerAceAllowed = globalThis.IsPlayerAceAllowed ?? (() => false);',
        'globalThis.GetConvar = globalThis.GetConvar ?? ((_n, fallback) => fallback);',
        'globalThis.GetConvarInt = globalThis.GetConvarInt ?? ((_n, fallback) => fallback);',
        /**
         * Shadowed, not stubbed globally, and only inside this bundle.
         *
         * Importing the services barrel starts four module-scope `setInterval` loops —
         * Battery, Signal, Music, HodlrMarket — each of which would then issue real queries
         * against whichever database the harness is currently pointed at, on its own
         * schedule. Background writes in the middle of assertions about row counts is how a
         * deterministic harness stops being one.
         *
         * A module-level `const` in an ESM bundle shadows the global for this file alone, so
         * the host process keeps a working `setInterval` (mysql2 needs one) and every
         * `if (typeof setInterval === 'function')` in the services still takes its branch
         * and calls nothing. `setTimeout` is deliberately left alone: `orphanSweep` yields
         * on it between delete chunks, and shadowing that would deadlock the thing under
         * test.
         */
        'const setInterval = () => 0;'
      ].join('\n')
    },
    outfile,
    logLevel: 'warning'
  });

  return await import(`file://${outfile}?t=${Date.now()}`);
};

/* ----------------------------------------------------------------- fixtures */

const PLAYERS_TABLE = `
CREATE TABLE IF NOT EXISTS players (
    citizenid varchar(50) NOT NULL,
    charinfo text DEFAULT NULL,
    PRIMARY KEY (citizenid)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;`;

const PEOPLE = ['CIT_A', 'CIT_B', 'CIT_EAVESDROPPER'];

/**
 * The rows the flattened baseline's constraints are judged against.
 *
 * Before the flatten this seeded five fixtures full of duplicates, because migrations
 * existed to clean them up and the fixtures were the mess they had to survive. The
 * baseline now creates `conversation_participant_unique` and `pair_key_unique` in their
 * final shape, so a duplicate cannot be inserted here at all -- which is the property
 * worth proving instead. What is left is the smallest legal graph the rejection tests
 * need: one genuine pair, and the people to build a second one from.
 */
const seedBaselineRows = async (connection, hasPlayers) => {
  if (hasPlayers) {
    await connection.query(PLAYERS_TABLE);
    for (const citizenid of PEOPLE) {
      await connection.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?)', [
        citizenid,
        JSON.stringify({ firstname: citizenid, lastname: 'Test', phone: `555-${citizenid}` })
      ]);
    }
  }

  const [conversation] = await connection.query(
    `INSERT INTO mica_messages_conversations
       (citizenid, is_group, name, participant_a, participant_b, status)
     VALUES (?, 0, ?, ?, ?, 'active')`,
    ['CIT_A', 'genuine pair', 'CIT_A', 'CIT_B']
  );
  const genuine = conversation.insertId;

  for (const [citizenid, role] of [
    ['CIT_A', 'admin'],
    ['CIT_B', 'member']
  ]) {
    await connection.query(
      `INSERT INTO mica_messages_participants
         (conversation_id, citizenid, role, left_at, status)
       VALUES (?, ?, ?, NULL, 'active')`,
      [genuine, citizenid, role]
    );
  }

  return { genuine };
};

/* -------------------------------------------------------------- assertions */

const indexesOn = async (connection, table) => {
  const [rows] = await connection.query(
    `SELECT DISTINCT index_name AS name, non_unique
       FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY index_name`,
    [table]
  );
  return rows.map((row) => `${row.name}${Number(row.non_unique) === 0 ? ' (unique)' : ''}`);
};

const scalar = async (connection, sql, params = []) => {
  const [rows] = await connection.query(sql, params);
  return rows.length > 0 ? Object.values(rows[0])[0] : null;
};
/* -------------------------------------------------------------- the run */

/**
 * Import a schema file into its own database and judge what it created.
 *
 * This used to be a migration test: regress the schema to its pre-migration shape, seed
 * the mess, run `runPendingMigrations`, assert it cleaned up. The flatten removed every
 * migration, so there is no "before" to regress to -- the baseline *is* the end state.
 * What survives is the half that was never really about migrations: that both generated
 * files import into a real MariaDB at all, and that the constraints they declare are
 * enforced by the database rather than merely written down.
 */
const runVariant = async ({ connection, schemaFile, hasPlayers, server }) => {
  const database = `mica_${path.basename(schemaFile, '.sql').replace(/\./g, '_')}`;
  step(`${schemaFile} — importing into \`${database}\``);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });

  if (hasPlayers) {
    // The framework owns this table; micaOS's foreign keys point at it. A stand-in with the
    // one column those keys name is all the schema needs to import.
    await connection.query(PLAYERS_TABLE);
  }

  const sql = fs.readFileSync(path.join(root, schemaFile), 'utf8');
  await connection.query(sql);
  console.log(`    imported ${schemaFile} without error`);
  checksRun += 1;

  const tables = await scalar(
    connection,
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name LIKE 'mica|_%' ESCAPE '|'"
  );
  check(`${schemaFile}: imports the mica tables`, Number(tables) > 20, true);

  /**
   * The ledger table outlives the migrations themselves, deliberately. Flattening reset
   * the list to empty; it did not delete the mechanism, and the next migration this repo
   * writes needs somewhere to record itself. A baseline that stopped creating the table
   * would fail that migration on a server that installed in between.
   */
  const ledger = await scalar(
    connection,
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = 'mica_schema_migrations'"
  );
  check(`${schemaFile}: the ledger table is still created`, Number(ledger), 1);

  // Pre-seeded with every migration on disk, so a fresh install never runs one against a
  // table that was created in its final shape.
  const seeded = await scalar(connection, 'SELECT COUNT(*) FROM mica_schema_migrations');
  check(
    `${schemaFile}: a fresh install seeds every migration on disk as already applied`,
    Number(seeded),
    server.migrations.length
  );

  const freshRun = await server.runPendingMigrations();
  check(`${schemaFile}: a fresh install applies nothing`, freshRun.applied, []);
  check(`${schemaFile}: a fresh install fails nothing`, freshRun.failed, null);
  check(`${schemaFile}: and has nothing left pending`, freshRun.remaining, []);

  step(`${schemaFile} — the constraints the baseline ships with`);
  const ids = await seedBaselineRows(connection, hasPlayers);

  const participantIndexes = await indexesOn(connection, 'mica_messages_participants');
  check(
    `${schemaFile}: the unique participant key is on`,
    participantIndexes.includes('conversation_participant_unique (unique)'),
    true
  );
  check(
    `${schemaFile}: and the old non-unique index is not`,
    participantIndexes.includes('conversation_participant'),
    false
  );

  let rejected = null;
  try {
    await connection.query(
      `INSERT INTO mica_messages_participants (conversation_id, citizenid, role, left_at, status)
       VALUES (?, ?, 'member', NULL, 'active')`,
      [ids.genuine, 'CIT_B']
    );
  } catch (error) {
    rejected = error.code;
  }
  check(
    `${schemaFile}: a duplicate participant is rejected by the database`,
    rejected,
    'ER_DUP_ENTRY'
  );

  step(`${schemaFile} — MICA-70: the audit ledger accepts 'viewed'`);
  let viewedRejected = null;
  try {
    await connection.query(
      `INSERT INTO mica_audit_logs (citizenid, action, service, method, target_id)
       VALUES (?, 'viewed', 'reports', 'queue', 1)`,
      ['CIT_A']
    );
  } catch (error) {
    viewedRejected = error.code;
  }
  check(
    `${schemaFile}: an audit row with action 'viewed' is accepted, not rejected by the enum`,
    viewedRejected,
    null
  );

  step(`${schemaFile} — MICA-161: the generated pair key`);
  const [pairRows] = await connection.query(
    'SELECT participant_a, participant_b, pair_key FROM mica_messages_conversations WHERE id = ?',
    [ids.genuine]
  );
  check(`${schemaFile}: pair_key is generated and normalised`, pairRows[0].pair_key, 'CIT_A|CIT_B');

  const conversationIndexes = await indexesOn(connection, 'mica_messages_conversations');
  check(
    `${schemaFile}: pair_key_unique is unique`,
    conversationIndexes.includes('pair_key_unique (unique)'),
    true
  );

  let pairRejected = null;
  try {
    // The exact pair the seed already holds, with the two citizenids reversed —
    // `LEAST`/`GREATEST` must still see them as the same pair.
    await connection.query(
      `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
       VALUES (?, 0, ?, ?, 'active')`,
      ['CIT_B', 'CIT_B', 'CIT_A']
    );
  } catch (error) {
    pairRejected = error.code;
  }
  check(`${schemaFile}: a reversed duplicate pair is rejected`, pairRejected, 'ER_DUP_ENTRY');

  // A *soft-deleted* duplicate must not block a later, genuinely new active pair —
  // `pair_key`'s CASE only ever gives an `active` row a non-null key, so a deleted row
  // occupies no slot in the unique index for a fresh pair to collide with.
  await connection.query(
    `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
     VALUES (?, 0, ?, ?, 'deleted')`,
    ['CIT_A', 'CIT_A', 'CIT_EAVESDROPPER']
  );
  let freshAfterDeleteRejected = null;
  try {
    await connection.query(
      `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
       VALUES (?, 0, ?, ?, 'active')`,
      ['CIT_A', 'CIT_EAVESDROPPER', 'CIT_A']
    );
  } catch (error) {
    freshAfterDeleteRejected = error.code;
  }
  check(
    `${schemaFile}: a soft-deleted duplicate does not block a fresh active pair`,
    freshAfterDeleteRejected,
    null
  );

  step(`${schemaFile} — the runner is idempotent with nothing to run`);
  const second = await server.runPendingMigrations();
  check(`${schemaFile}: a second call still applies nothing`, second.applied, []);
  check(`${schemaFile}: and still reports no failure`, second.failed, null);
};

/* --------------------------------------------- MICA-152: the orphan sweep */

/**
 * es_extended's own table, in the one shape micaOS reads it in.
 *
 * `identifier` is wider than micaOS's `citizenid varchar(50)` on purpose — stock ESX varies
 * between varchar(46) and varchar(60), and an `esx_multicharacter` identifier
 * (`char1:license:<40 hex>`) is 54. micaOS's column is the binding constraint, and the
 * mismatch that causes is MICA-158 rather than this ticket. The fixtures below stay inside
 * 50 characters so they are testing the sweep and not that bug.
 */
const USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
    identifier varchar(60) NOT NULL,
    firstname varchar(50) DEFAULT NULL,
    lastname varchar(50) DEFAULT NULL,
    PRIMARY KEY (identifier)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;`;

const SWEEP_LIVE = 'char1:license:aaaaaaaaaaaaaaaaaa';
const SWEEP_GONE = 'char1:license:bbbbbbbbbbbbbbbbbb';

/** Framework stand-ins. `exposes` only ever reads one key off the resource it probes. */
const FRAMEWORK = {
  qb: (name) => (name === 'qbx_core' ? { GetPlayer: () => null } : undefined),
  esx: (name) => (name === 'es_extended' ? { getSharedObject: () => ({}) } : undefined),
  /** Neither has started yet. A legal `server.cfg` puts micaOS above its framework. */
  none: () => undefined
};

/**
 * Rows for one character who exists and one who does not, across three tables.
 *
 * `mica_audit_logs` is in there because it is the one swept table with no `defineService`
 * behind it, so a derivation bug that dropped it would otherwise show up nowhere.
 */
const seedSweepRows = async (connection, live, gone) => {
  for (const table of ['mica_notes', 'mica_contacts', 'mica_audit_logs']) {
    await connection.query(`DELETE FROM ${table}`);
  }
  await connection.query(
    'INSERT INTO mica_notes (citizenid, title, content) VALUES (?,?,?), (?,?,?), (?,?,?)',
    [live, 'mine', 'a', gone, 'ghost', 'b', gone, 'ghost again', 'c']
  );
  await connection.query(
    'INSERT INTO mica_contacts (citizenid, firstname, phone) VALUES (?,?,?), (?,?,?)',
    [live, 'Live', '555-0001', gone, 'Gone', '555-0002']
  );
  await connection.query(
    'INSERT INTO mica_audit_logs (citizenid, action, service, method, target_id) VALUES (?,?,?,?,?)',
    [gone, 'deleted', 'notes', 'delete', 1]
  );
};

const rowsIn = async (connection, table) =>
  Number(await scalar(connection, `SELECT COUNT(*) FROM ${table}`));

/**
 * MICA-152, against a real server rather than a mocked `Database`.
 *
 * The unit suite asserts the SQL as text, which cannot tell you whether MariaDB accepts
 * `DELETE … WHERE NOT EXISTS … LIMIT n`, and cannot tell you what an empty owner table
 * actually does. Those are the two questions worth a container.
 *
 * **The fail-closed cases are the point.** A sweep that reads "I cannot see the owner table"
 * as "everything is an orphan" deletes every row on the server while logging a success, so
 * each case below breaks exactly one precondition and asserts the row counts did not move —
 * not merely that the return value was zero, which a guard that stopped running would also
 * produce.
 */
const runSweepFixtures = async ({ connection, schemaFile, hasPlayers, server }) => {
  const variant = hasPlayers ? 'qb' : 'esx';
  const database = `mica_sweep_${variant}`;
  const ownerTable = hasPlayers ? 'players' : 'users';
  const label = `${schemaFile} sweep`;

  step(`${schemaFile} — MICA-152 orphan sweep, on a ${variant} server`);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });
  await connection.query(hasPlayers ? PLAYERS_TABLE : USERS_TABLE);
  await connection.query(fs.readFileSync(path.join(root, schemaFile), 'utf8'));

  const live = hasPlayers ? 'CIT_LIVE' : SWEEP_LIVE;
  const gone = hasPlayers ? 'CIT_GONE' : SWEEP_GONE;
  const ownerColumn = hasPlayers ? 'citizenid' : 'identifier';
  const addOwner = (id) =>
    connection.query(`INSERT INTO ${ownerTable} (${ownerColumn}) VALUES (?)`, [id]);

  server.__setResourceLookup(FRAMEWORK[variant]);
  check(`${label}: detects the framework`, server.detectFramework(), variant);
  check(`${label}: resolves the owner table`, server.FrameworkBridge.ownerTable(), {
    table: ownerTable,
    column: ownerColumn
  });

  // The derived set, against the schema that actually imported. The unit suite ties it to
  // the committed file; this ties it to the live database, which is the thing rows are in.
  const swept = server.ownedTables().map((t) => t.table);
  // `mica_%` only, and the underscore escaped so it is a literal rather than a
  // single-character wildcard. On qb the framework's own `players` also has a `citizenid`
  // column and is emphatically not something micaOS sweeps.
  const [liveTables] = await connection.query(
    `SELECT t.table_name AS name FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = DATABASE()
        AND t.table_name LIKE 'mica|_%' ESCAPE '|'
        AND c.column_name = 'citizenid'`
  );
  check(
    `${label}: sweeps exactly the imported tables that carry a citizenid`,
    swept.toSorted(),
    liveTables.map((r) => r.name).toSorted()
  );
  check(
    `${label}: includes the audit ledger, which no declaration produces`,
    swept.includes('mica_audit_logs'),
    true
  );
  check(`${label}: never sweeps the framework's own table`, swept.includes(ownerTable), false);

  /* --- it works ------------------------------------------------------------ */

  await addOwner(live);

  if (hasPlayers) {
    /**
     * qb first, because "qb behaviour is unchanged" is the claim most worth executing.
     *
     * With the cascade intact there is nothing for the sweep to find — an orphan cannot even
     * be *inserted*, since the foreign key rejects a citizenid with no `players` row. So the
     * order here is: prove the sweep is a no-op, prove the cascade still does the work, and
     * only then reach the state the sweep exists for.
     */
    await addOwner(gone);
    await seedSweepRows(connection, live, gone);

    const intact = await server.sweepOrphanedRows();
    check(`${label}: with the cascade intact the sweep removes nothing`, intact.removed, 0);
    check(`${label}: and leaves every row where it was`, await rowsIn(connection, 'mica_notes'), 3);

    await connection.query(`DELETE FROM ${ownerTable} WHERE ${ownerColumn} = ?`, [gone]);
    check(
      `${label}: the cascade still takes a deleted character's rows, unchanged`,
      await rowsIn(connection, 'mica_notes'),
      1
    );

    /**
     * Now the case the sweep is the backstop for on qb: an install whose tables were created
     * before the constraint existed. `SchemaMigrator` adds columns and indexes and
     * deliberately never adds a foreign key, so such a server keeps the shape it was made
     * with and nothing cleans up after a deleted character — the ESX condition, arrived at
     * from a different direction.
     */
    for (const [table, key] of [
      ['mica_notes', 'fk_notes_citizenid'],
      ['mica_contacts', 'fk_contacts_citizenid'],
      ['mica_audit_logs', 'fk_audit_logs_citizenid']
    ]) {
      await connection.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${key}`);
    }
  }

  await seedSweepRows(connection, live, gone);

  const sweptResult = await server.sweepOrphanedRows();
  check(`${label}: the sweep ran rather than refusing`, sweptResult.skipped, null);
  check(
    `${label}: nothing failed per-table`,
    sweptResult.failures.map((f) => f.table),
    []
  );
  check(`${label}: the orphans are gone`, await rowsIn(connection, 'mica_notes'), 1);
  check(
    `${label}: the live character kept their contact`,
    await rowsIn(connection, 'mica_contacts'),
    1
  );

  /* --- and now every way it must refuse ------------------------------------ */

  const reseed = async () => {
    await connection.query(`DELETE FROM ${ownerTable}`);
    await addOwner(live);
    await seedSweepRows(connection, live, gone);
  };

  const refuses = async (why, expected) => {
    const before = await rowsIn(connection, 'mica_notes');
    const result = await server.sweepOrphanedRows();
    check(`${label}: ${why} — refuses with '${expected}'`, result.skipped, expected);
    check(`${label}: ${why} — DELETED NOTHING`, await rowsIn(connection, 'mica_notes'), before);
  };

  await reseed();
  await connection.query(`DELETE FROM ${ownerTable}`);
  await refuses('an empty owner table', 'owner-empty');

  // The one that would wipe twenty-two tables while logging success: an owner table that is
  // present and populated but holds identities from a different framework entirely. On an
  // ESX box that is a leftover `players` from a previous qb install; every micaOS row then
  // looks unowned.
  await connection.query(`INSERT INTO ${ownerTable} (${ownerColumn}) VALUES (?), (?)`, [
    'SOMEBODY_ELSE_1',
    'SOMEBODY_ELSE_2'
  ]);
  await refuses('a populated owner table full of strangers', 'identity-mismatch');

  // Unreadable rather than empty. On ESX today this is the *only* thing standing between a
  // sweep and the whole database, and it is the `catch` doing it rather than the count.
  await connection.query(`RENAME TABLE ${ownerTable} TO ${ownerTable}_hidden`);
  await refuses('an owner table that does not exist', 'owner-unreadable');
  await connection.query(`RENAME TABLE ${ownerTable}_hidden TO ${ownerTable}`);

  // The boot-order case. micaOS can start before its framework, and a two-state verdict
  // would answer "qb" here — on a box that may well still have a stale `players`.
  server.__setResourceLookup(FRAMEWORK.none);
  await refuses('no framework has answered yet', 'unknown-framework');

  /* --- the purge hook, which is told rather than inferring ------------------ */

  // Deliberately not guarded on the owner table: it is handed a citizenid by a resource
  // that just deleted the character, so there is no absence of evidence to misread. It has
  // to keep working on exactly the servers where the owner row is already gone.
  const purge = await server.purgeOwnedRows(gone);
  check(`${label}: the purge works with no framework at all`, purge.removed > 0, true);
  check(
    `${label}: the purge left the live character alone`,
    await rowsIn(connection, 'mica_notes'),
    1
  );
  check(
    `${label}: the purge reached the audit ledger`,
    await rowsIn(connection, 'mica_audit_logs'),
    0
  );

  server.__setResourceLookup();
};

/* --------------------------------- MICA-284: the number follows the phone */

const NUMBERS = 'mica_phone_numbers';
const NUMBER_MIGRATION = '0001_phone_numbers_follow_the_phone';
const A_PHONE = 'a'.repeat(32);
const B_PHONE = 'b'.repeat(32);

/**
 * Put `mica_phone_numbers` back into the shape MICA-151 shipped, so there is something to
 * migrate. The baseline is the end state, so the "before" is reconstructed by hand from the
 * DDL as it stood: no `phone_id`, no `phone_id_unique`, `citizenid_unique` present — and the
 * ledger row the seed pre-inserted taken out, so the runner sees the migration as pending.
 */
const regressNumbersTable = async (connection) => {
  await connection.query(
    `ALTER TABLE ${NUMBERS}
       DROP KEY phone_id_unique,
       DROP COLUMN phone_id,
       ADD UNIQUE KEY citizenid_unique (citizenid)`
  );
  await connection.query('DELETE FROM mica_schema_migrations WHERE id = ?', [NUMBER_MIGRATION]);
};

/**
 * The qb characters the seed is judged against. One of each thing `charinfo` can do to it.
 *
 * `CIT_HAS` is a server that ran standalone before installing qb: a micaOS row already exists,
 * carrying a different number than `charinfo` says, and it has to win. The pair sharing a
 * number is the one case where somebody's number *does* change, and the migration prints how
 * many.
 */
const QB_CHARACTERS = [
  ['CIT_A', { firstname: 'Ada', lastname: 'Lovelace', phone: '5550001' }],
  ['CIT_B', { firstname: 'Bob', lastname: 'Test', phone: '5550002' }],
  ['CIT_DUP1', { phone: '5550009' }],
  ['CIT_DUP2', { phone: '5550009' }],
  ['CIT_NONE', { firstname: 'No', lastname: 'Phone' }],
  ['CIT_NULL', { phone: null }],
  ['CIT_EMPTY', { phone: '' }],
  ['CIT_LONG', { phone: '1'.repeat(17) }],
  ['CIT_NUM', { phone: 5550004 }],
  ['CIT_HAS', { phone: '5550005' }]
];

const insertNumber = (connection, citizenid, number, phoneId) =>
  connection.query(`INSERT INTO ${NUMBERS} (citizenid, number, phone_id) VALUES (?, ?, ?)`, [
    citizenid,
    number,
    phoneId
  ]);

const rejects = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    return error.code;
  }
};

/**
 * MICA-284's migration, executed rather than read.
 *
 * The unit suite asserts the statements as text and cannot tell you whether MariaDB accepts
 * `INSERT IGNORE ... SELECT ... NOT EXISTS` over a JSON column, whether the seed really skips
 * what it says it skips, or whether the column the migration adds is the column the
 * declaration describes. The last is the one worth a container: a fresh install and an
 * upgraded one must end up identical, and the additive planner is what judges that.
 */
const runNumberMigration = async ({ connection, schemaFile, hasPlayers, server }) => {
  const variant = hasPlayers ? 'qb' : 'esx';
  const database = `mica_numbers_${variant}`;
  const label = `${schemaFile} numbers`;

  step(`${schemaFile} — MICA-284 ${NUMBER_MIGRATION}, on a ${variant} server`);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });
  if (hasPlayers) await connection.query(PLAYERS_TABLE);
  await connection.query(fs.readFileSync(path.join(root, schemaFile), 'utf8'));
  await regressNumbersTable(connection);

  const before = await indexesOn(connection, NUMBERS);
  check(
    `${label}: the regressed table is MICA-151's shape`,
    [before.includes('citizenid_unique (unique)'), before.includes('phone_id_unique (unique)')],
    [true, false]
  );

  const live = hasPlayers ? 'CIT_A' : SWEEP_LIVE;
  if (hasPlayers) {
    for (const [citizenid, charinfo] of QB_CHARACTERS) {
      await connection.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?)', [
        citizenid,
        JSON.stringify(charinfo)
      ]);
    }
    await connection.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?)', [
      'CIT_BAD',
      '{not json'
    ]);
    await connection.query(`INSERT INTO ${NUMBERS} (citizenid, number) VALUES (?, ?)`, [
      'CIT_HAS',
      '5560005'
    ]);
  } else {
    // Rows standalone issued, which only need the new column. Nothing to seed from.
    await connection.query(`INSERT INTO ${NUMBERS} (citizenid, number) VALUES (?, ?), (?, ?)`, [
      SWEEP_LIVE,
      '5560001',
      SWEEP_GONE,
      '5560002'
    ]);
  }

  const run = await server.runPendingMigrations();
  check(`${label}: the migration applied`, run.applied, [NUMBER_MIGRATION]);
  check(`${label}: and failed nothing`, run.failed, null);

  const after = await indexesOn(connection, NUMBERS);
  check(
    `${label}: phone_id_unique is on, citizenid_unique is gone, number_unique stays`,
    [
      after.includes('phone_id_unique (unique)'),
      after.includes('citizenid_unique (unique)'),
      after.includes('number_unique (unique)')
    ],
    [true, false, true]
  );

  const [columns] = await connection.query(
    `SELECT column_type AS type, is_nullable AS nullable FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'phone_id'`,
    [NUMBERS]
  );
  check(`${label}: phone_id is a nullable varchar(32)`, columns[0], {
    type: 'varchar(32)',
    nullable: 'YES'
  });

  // The property that matters most: the migrated table *is* the declared table, so the
  // additive pass that follows in `micaschema apply` has nothing to add and nothing to
  // report. A fresh install and an upgraded one cannot disagree.
  const plan = (await server.SchemaMigrator.plan()).find((p) => p.table === NUMBERS);
  check(`${label}: the additive pass finds nothing to add`, plan.additive, []);
  check(`${label}: and reports no drift`, plan.drift, []);

  const [rows] = await connection.query(
    `SELECT citizenid, number, phone_id FROM ${NUMBERS} ORDER BY citizenid`
  );
  const numbers = Object.fromEntries(rows.map((r) => [r.citizenid, r.number]));

  if (hasPlayers) {
    const dups = Object.keys(numbers).filter((c) => c.startsWith('CIT_DUP'));
    check(`${label}: exactly one of the pair sharing a number got it`, dups.length, 1);
    check(`${label}: and it is the number they shared`, numbers[dups[0]], '5550009');
    check(
      `${label}: every other character with a usable number got a legacy row, and nobody else`,
      Object.keys(numbers)
        .filter((c) => !c.startsWith('CIT_DUP'))
        .sort(),
      ['CIT_A', 'CIT_B', 'CIT_HAS', 'CIT_NUM']
    );
    check(`${label}: a string number is seeded as-is`, numbers.CIT_A, '5550001');
    check(`${label}: a JSON number is seeded as text`, numbers.CIT_NUM, '5550004');
    check(`${label}: a row that already existed keeps its number`, numbers.CIT_HAS, '5560005');
  } else {
    check(`${label}: the rows standalone issued are untouched`, numbers, {
      [SWEEP_LIVE]: '5560001',
      [SWEEP_GONE]: '5560002'
    });
  }
  check(
    `${label}: no seeded row is on a phone yet`,
    rows.every((r) => r.phone_id === null),
    true
  );

  // Re-running `up()` by hand — a retry after a failed ledger write — adds nothing now that
  // the citizen key is gone. This is the claim the `NOT EXISTS` in the seed exists for.
  const count = () => rowsIn(connection, NUMBERS);
  const beforeRetry = await count();
  await server.migrations.find((m) => m.id === NUMBER_MIGRATION).up();
  check(`${label}: running up() a second time adds no rows`, await count(), beforeRetry);

  step(`${schemaFile} — the constraints the migrated table enforces`);
  await insertNumber(connection, live, '5567777', A_PHONE);
  check(
    `${label}: a citizen may now hold a second number, on a phone`,
    await scalar(connection, `SELECT COUNT(*) FROM ${NUMBERS} WHERE citizenid = ?`, [live]),
    2
  );
  check(
    `${label}: a second number on the same phone is rejected by the database`,
    await rejects(() => insertNumber(connection, live, '5568888', A_PHONE)),
    'ER_DUP_ENTRY'
  );
  check(
    `${label}: the same number on a second phone is rejected too`,
    await rejects(() => insertNumber(connection, live, '5567777', B_PHONE)),
    'ER_DUP_ENTRY'
  );
  check(
    `${label}: any number of legacy rows coexist, because NULL is exempt from the key`,
    await rejects(() => insertNumber(connection, live, '5569999', null)),
    null
  );

  const second = await server.runPendingMigrations();
  check(`${label}: a second run applies nothing`, second.applied, []);
  check(`${label}: and reports no failure`, second.failed, null);
};

const main = async () => {
  let container;
  let connection;
  try {
    if (EXTERNAL_DB) {
      // Validate all four environment variables are set
      if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD) {
        throw new Error(
          'all four of MICA_DB_HOST, MICA_DB_PORT, MICA_DB_USER, MICA_DB_PASSWORD ' +
            'must be provided together. Nothing was tested.'
        );
      }
      step('connecting to provided database');
      connection = await mysql.createConnection({
        host: DB_HOST,
        port: Number(DB_PORT),
        user: DB_USER,
        password: DB_PASSWORD,
        multipleStatements: true
      });
      console.log(`    connected to ${DB_HOST}:${DB_PORT}`);
    } else {
      assertDockerUsable();
      container = startContainer();
      connection = await connectWhenReady(container.port);
    }
    installOxmysql(connection);
    const server = await loadServerModule();

    // What catches a migration added to the directory without the barrel being regenerated.
    check(
      'the barrel exposes every migration on disk',
      server.migrations.map((m) => m.id),
      fs
        .readdirSync(path.join(root, 'server', 'migrations'))
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => f.replace(/\.ts$/, ''))
        .sort()
    );

    // Both files, because `mica.esx.sql` is generated by a transformation and has never
    // been imported anywhere. If it is not valid SQL, that is a MICA-150 finding.
    await runVariant({ connection, schemaFile: 'mica.sql', hasPlayers: true, server });
    await runVariant({ connection, schemaFile: 'mica.esx.sql', hasPlayers: false, server });

    // MICA-152. Both frameworks, because the sweep's whole job is to be the cascade ESX
    // does not have — and because "qb is unchanged" is a claim worth executing rather than
    // reasoning about.
    await runSweepFixtures({ connection, schemaFile: 'mica.sql', hasPlayers: true, server });
    await runSweepFixtures({
      connection,
      schemaFile: 'mica.esx.sql',
      hasPlayers: false,
      server
    });

    // MICA-284. Both shapes, because the seed reads qb's `players.charinfo` and has to do
    // nothing — loudly — where there is no such table.
    await runNumberMigration({ connection, schemaFile: 'mica.sql', hasPlayers: true, server });
    await runNumberMigration({
      connection,
      schemaFile: 'mica.esx.sql',
      hasPlayers: false,
      server
    });

    if (checksRun < MINIMUM_CHECKS) {
      throw new Error(
        `only ${checksRun} checks ran, fewer than the ${MINIMUM_CHECKS} expected. Something ` +
          'returned early — treat this as a failure, not a pass.'
      );
    }

    if (EXTERNAL_DB) {
      console.log(`\nAll ${checksRun} checks passed.`);
    } else {
      console.log(`\nAll ${checksRun} checks passed against ${IMAGE}.`);
    }
  } finally {
    if (connection) await connection.end().catch(() => {});
    if (container) stopContainer(container.id);
  }
};

main().catch((error) => {
  console.error(`\nmigration harness FAILED: ${error.message}`);
  console.error('\nNothing here is a pass. Fix the failure or the environment and re-run.');
  process.exit(1);
});
