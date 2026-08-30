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
const CONTAINER_LABEL = 'gphone-migration-harness';
const ROOT_PASSWORD = 'gphone-throwaway';
/** How long to wait for the server to accept connections, in ms. */
const READY_TIMEOUT = 90_000;

/**
 * The number of duplicate rows the fixtures build. Large enough that a bug which processes
 * only the first duplicate is visible in a count, small enough not to slow the run.
 */
const DUPLICATES = 500;

/**
 * Assertions are counted, and the run fails if too few of them happened.
 *
 * The same reasoning as `changelog.test.ts`'s "the check fires, rather than merely being
 * configured": a harness that returns early — a fixture that silently seeded nothing, a loop
 * over an empty list — would otherwise print a pass having checked almost nothing.
 */
const MINIMUM_CHECKS = 40;
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
    `export { migrations } from '${root}/server/migrations/index.ts';`
  ].join('\n');

  const outfile = path.join(root, 'node_modules', '.cache', 'gphone-migration-harness.mjs');
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
        "globalThis.GetCurrentResourceName = globalThis.GetCurrentResourceName ?? (() => 'gphone');",
        'globalThis.RegisterCommand = globalThis.RegisterCommand ?? (() => {});',
        'globalThis.IsPlayerAceAllowed = globalThis.IsPlayerAceAllowed ?? (() => false);',
        'globalThis.GetConvar = globalThis.GetConvar ?? ((_n, fallback) => fallback);'
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

const PEOPLE = ['CIT_A', 'CIT_B', 'CIT_EAVESDROPPER', 'CIT_VICTIM', 'CIT_VICTIM2', 'CIT_C'];

/**
 * The five states MICA-153 has to survive, plus the rows the constraint has to reject.
 *
 * Numbers 3 and 4 are the pair the migration's ordering is about, and 5 is the one that
 * decides whether a person currently in a thread can be deleted out of it: its closed row is
 * inserted *first*, so it holds the lower id and a naive `MIN(id)` would keep the wrong one.
 */
const seedFixtures = async (connection, hasPlayers) => {
  if (hasPlayers) {
    await connection.query(PLAYERS_TABLE);
    for (const citizenid of PEOPLE) {
      await connection.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?)', [
        citizenid,
        JSON.stringify({ firstname: citizenid, lastname: 'Test', phone: `555-${citizenid}` })
      ]);
    }
  }

  const conversation = async (isGroup, name) => {
    const [result] = await connection.query(
      'INSERT INTO gphone_messages_conversations (citizenid, is_group, name, status) VALUES (?, ?, ?, ?)',
      ['CIT_A', isGroup, name, 'active']
    );
    return result.insertId;
  };

  const participant = async (conversationId, citizenid, { left = false, role = 'member' } = {}) => {
    await connection.query(
      `INSERT INTO gphone_messages_participants
         (conversation_id, citizenid, role, left_at, status)
       VALUES (?, ?, ?, ${left ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)`,
      [conversationId, citizenid, role, left ? 'left' : 'active']
    );
  };

  // 1. A genuine one-to-one. Must stay a one-to-one.
  const genuine = await conversation(0, 'genuine pair');
  await participant(genuine, 'CIT_A', { role: 'admin' });
  await participant(genuine, 'CIT_B');

  // 2. The attack: is_group forged to 0 with a silent third party. Must flip to 1.
  const forged = await conversation(0, 'forged pair');
  await participant(forged, 'CIT_A', { role: 'admin' });
  await participant(forged, 'CIT_B');
  await participant(forged, 'CIT_EAVESDROPPER');

  // 3. A one-to-one where the victim carries DUPLICATES live rows. Must stay 0, which only
  //    holds if the dedupe runs before the recount.
  const liveDupes = await conversation(0, 'live duplicates');
  await participant(liveDupes, 'CIT_A', { role: 'admin' });
  for (let i = 0; i < DUPLICATES; i += 1) await participant(liveDupes, 'CIT_VICTIM');

  // 4. The same, but the victim already left, so `removeParticipant` closed every row at
  //    once. Invisible to a live-only dedupe, and still a constraint violation.
  const closedDupes = await conversation(0, 'closed duplicates');
  await participant(closedDupes, 'CIT_A', { role: 'admin' });
  for (let i = 0; i < DUPLICATES; i += 1) {
    await participant(closedDupes, 'CIT_VICTIM2', { left: true });
  }

  // 5. One closed row inserted before a live one, so the live row has the higher id. The
  //    live row must survive: deleting it would drop a current member out of the thread.
  const mixed = await conversation(0, 'closed then live');
  await participant(mixed, 'CIT_A', { role: 'admin' });
  await participant(mixed, 'CIT_C', { left: true });
  await participant(mixed, 'CIT_C');

  return { genuine, forged, liveDupes, closedDupes, mixed };
};

/**
 * Put the participants table back into the shape a server that has never migrated has.
 *
 * Without this the harness proves far less than it appears to. `gphone.sql` is generated
 * from the current declaration, so a fresh import already carries the unique key — both
 * `information_schema` guards would find their work done, skip, and report a pass having
 * executed no DDL at all. Regressing the index is what makes the `ADD`/`DROP` path real.
 */
const regressToPreMigrationShape = async (connection) => {
  await connection.query(
    'ALTER TABLE gphone_messages_participants DROP INDEX conversation_participant_unique'
  );
  await connection.query(
    'ALTER TABLE gphone_messages_participants ADD KEY conversation_participant (conversation_id, citizenid)'
  );
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

const liveCount = (connection, conversationId, citizenid) =>
  scalar(
    connection,
    'SELECT COUNT(*) FROM gphone_messages_participants WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL',
    [conversationId, citizenid]
  );

const totalCount = (connection, conversationId, citizenid) =>
  scalar(
    connection,
    'SELECT COUNT(*) FROM gphone_messages_participants WHERE conversation_id = ? AND citizenid = ?',
    [conversationId, citizenid]
  );

const isGroupOf = (connection, conversationId) =>
  scalar(connection, 'SELECT is_group FROM gphone_messages_conversations WHERE id = ?', [
    conversationId
  ]);

/* -------------------------------------------------------------- the run */

const runVariant = async ({ connection, schemaFile, hasPlayers, server }) => {
  const database = `gphone_${path.basename(schemaFile, '.sql').replace(/\./g, '_')}`;
  step(`${schemaFile} — importing into \`${database}\``);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });

  if (hasPlayers) {
    // The framework owns this table; gPhone's foreign keys point at it. A stand-in with the
    // one column those keys name is all the schema needs to import.
    await connection.query(PLAYERS_TABLE);
  }

  const sql = fs.readFileSync(path.join(root, schemaFile), 'utf8');
  await connection.query(sql);
  console.log(`    imported ${schemaFile} without error`);
  checksRun += 1;

  const tables = await scalar(
    connection,
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name LIKE 'gphone|_%' ESCAPE '|'"
  );
  check(`${schemaFile}: imports the gphone tables`, Number(tables) > 20, true);

  /**
   * A fresh install must NOT run the migration: `gphone.sql` seeds the ledger so every
   * migration is marked applied against tables that were created in their final shape.
   */
  const seeded = await scalar(
    connection,
    'SELECT COUNT(*) FROM gphone_schema_migrations WHERE id = ?',
    ['0001_repair_conversation_participants']
  );
  check(`${schemaFile}: a fresh install has the migration pre-seeded`, Number(seeded), 1);

  const freshRun = await server.runPendingMigrations();
  check(`${schemaFile}: a fresh install applies nothing`, freshRun.applied, []);
  check(`${schemaFile}: a fresh install fails nothing`, freshRun.failed, null);

  step(`${schemaFile} — regressing to a pre-migration server and seeding fixtures`);
  // An existing server has neither the ledger row nor the unique key.
  await connection.query('DELETE FROM gphone_schema_migrations');
  await regressToPreMigrationShape(connection);

  const before = await indexesOn(connection, 'gphone_messages_participants');
  check(
    `${schemaFile}: starts with the old non-unique index`,
    before.includes('conversation_participant'),
    true
  );
  check(
    `${schemaFile}: starts without the unique one`,
    before.includes('conversation_participant_unique (unique)'),
    false
  );

  const ids = await seedFixtures(connection, hasPlayers);
  check(
    `${schemaFile}: fixture 3 seeded ${DUPLICATES} live rows`,
    Number(await liveCount(connection, ids.liveDupes, 'CIT_VICTIM')),
    DUPLICATES
  );
  check(
    `${schemaFile}: fixture 4 seeded ${DUPLICATES} closed rows`,
    Number(await totalCount(connection, ids.closedDupes, 'CIT_VICTIM2')),
    DUPLICATES
  );

  const forgedUpdatedAt = await scalar(
    connection,
    'SELECT updated_at FROM gphone_messages_conversations WHERE id = ?',
    [ids.forged]
  );

  step(`${schemaFile} — running the real runPendingMigrations`);
  const result = await server.runPendingMigrations();
  check(`${schemaFile}: reports no failure`, result.failed, null);
  check(`${schemaFile}: applied the migration`, result.applied, [
    '0001_repair_conversation_participants'
  ]);
  check(`${schemaFile}: nothing left over`, result.remaining, []);

  step(`${schemaFile} — the five fixtures`);
  check(
    `1. a genuine one-to-one stays a one-to-one`,
    Number(await isGroupOf(connection, ids.genuine)),
    0
  );
  check(
    `2. a forged one-to-one with a third party flips to a group`,
    Number(await isGroupOf(connection, ids.forged)),
    1
  );
  check(
    `3. duplicates do not turn a one-to-one into a group`,
    Number(await isGroupOf(connection, ids.liveDupes)),
    0
  );
  check(
    `3. the victim keeps exactly one live row`,
    Number(await liveCount(connection, ids.liveDupes, 'CIT_VICTIM')),
    1
  );
  check(
    `3. and exactly one row in total`,
    Number(await totalCount(connection, ids.liveDupes, 'CIT_VICTIM')),
    1
  );
  check(
    `4. closed duplicates do not make a group either`,
    Number(await isGroupOf(connection, ids.closedDupes)),
    0
  );
  check(
    `4. the departed victim keeps exactly one row`,
    Number(await totalCount(connection, ids.closedDupes, 'CIT_VICTIM2')),
    1
  );
  check(
    `5. the live row survives an older closed one`,
    Number(await liveCount(connection, ids.mixed, 'CIT_C')),
    1
  );
  check(
    `5. and it is the only row left`,
    Number(await totalCount(connection, ids.mixed, 'CIT_C')),
    1
  );

  // Everyone who should still be in a thread still is.
  check(
    `nobody was deleted out of a thread`,
    Number(await liveCount(connection, ids.genuine, 'CIT_B')),
    1
  );
  check(
    `the eavesdropper is still there, now visible`,
    Number(await liveCount(connection, ids.forged, 'CIT_EAVESDROPPER')),
    1
  );

  step(`${schemaFile} — the constraint, and updated_at`);
  const after = await indexesOn(connection, 'gphone_messages_participants');
  check(`the unique key is on`, after.includes('conversation_participant_unique (unique)'), true);
  check(`the old index is gone`, after.includes('conversation_participant'), false);

  let rejected = null;
  try {
    await connection.query(
      `INSERT INTO gphone_messages_participants (conversation_id, citizenid, role, left_at, status)
       VALUES (?, ?, 'member', NULL, 'active')`,
      [ids.genuine, 'CIT_B']
    );
  } catch (error) {
    rejected = error.code;
  }
  check(`a fresh duplicate is rejected by the database`, rejected, 'ER_DUP_ENTRY');

  const forgedUpdatedAfter = await scalar(
    connection,
    'SELECT updated_at FROM gphone_messages_conversations WHERE id = ?',
    [ids.forged]
  );
  check(
    `updated_at is preserved on a row the migration changed`,
    String(forgedUpdatedAfter),
    String(forgedUpdatedAt)
  );

  step(`${schemaFile} — running it a second time`);
  const rowsBefore = await scalar(connection, 'SELECT COUNT(*) FROM gphone_messages_participants');
  const second = await server.runPendingMigrations();
  check(`the ledger stops a second apply`, second.applied, []);
  check(`and reports no failure`, second.failed, null);
  check(
    `no rows changed`,
    Number(await scalar(connection, 'SELECT COUNT(*) FROM gphone_messages_participants')),
    Number(rowsBefore)
  );

  /**
   * And once more with the ledger cleared, which is the state a failed ledger write leaves
   * behind — `runMigrations` tells an operator the migration ran but was not recorded, and
   * they have to decide whether to retry. This is that retry.
   */
  await connection.query('DELETE FROM gphone_schema_migrations');
  const replay = await server.runPendingMigrations();
  check(`a forced replay still succeeds`, replay.failed, null);
  check(`a forced replay applies cleanly`, replay.applied, [
    '0001_repair_conversation_participants'
  ]);
  check(
    `a forced replay changes no rows`,
    Number(await scalar(connection, 'SELECT COUNT(*) FROM gphone_messages_participants')),
    Number(rowsBefore)
  );
  const replayIndexes = await indexesOn(connection, 'gphone_messages_participants');
  check(
    `a forced replay leaves the unique key alone`,
    replayIndexes.includes('conversation_participant_unique (unique)'),
    true
  );
};

const main = async () => {
  assertDockerUsable();

  let container;
  let connection;
  try {
    container = startContainer();
    connection = await connectWhenReady(container.port);
    installOxmysql(connection);
    const server = await loadServerModule();

    check(
      'the barrel exposes every migration on disk',
      server.migrations.map((m) => m.id),
      fs
        .readdirSync(path.join(root, 'server', 'migrations'))
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => f.replace(/\.ts$/, ''))
        .sort()
    );

    // Both files, because `gphone.esx.sql` is generated by a transformation and has never
    // been imported anywhere. If it is not valid SQL, that is a MICA-150 finding.
    await runVariant({ connection, schemaFile: 'gphone.sql', hasPlayers: true, server });
    await runVariant({ connection, schemaFile: 'gphone.esx.sql', hasPlayers: false, server });

    if (checksRun < MINIMUM_CHECKS) {
      throw new Error(
        `only ${checksRun} checks ran, fewer than the ${MINIMUM_CHECKS} expected. Something ` +
          'returned early — treat this as a failure, not a pass.'
      );
    }

    console.log(`\nAll ${checksRun} checks passed against ${IMAGE}.`);
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
