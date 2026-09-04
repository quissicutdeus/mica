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
const MINIMUM_CHECKS = 70;
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
    `export { __setResourceLookup, detectFramework, FrameworkBridge } from '${root}/server/lib/FrameworkBridge.ts';`
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
      'INSERT INTO mica_messages_conversations (citizenid, is_group, name, status) VALUES (?, ?, ?, ?)',
      ['CIT_A', isGroup, name, 'active']
    );
    return result.insertId;
  };

  const participant = async (conversationId, citizenid, { left = false, role = 'member' } = {}) => {
    await connection.query(
      `INSERT INTO mica_messages_participants
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
 * Put the participants table, and the conversations table, back into the shape a server
 * that has never migrated has.
 *
 * Without this the harness proves far less than it appears to. `mica.sql` is generated
 * from the current declaration, so a fresh import already carries the unique key — both
 * `information_schema` guards would find their work done, skip, and report a pass having
 * executed no DDL at all. Regressing the index (0001) and dropping the pair-key columns
 * (0002) is what makes each migration's real DDL path execute rather than no-op.
 *
 * Dropping `pair_key` first, rather than the two ordinary columns first, is deliberate:
 * MySQL/MariaDB drop an index automatically when the last column it covers is dropped, so
 * this one statement also removes `pair_key_unique` — there is nothing else indexing
 * `participant_a`/`participant_b` to worry about disturbing by dropping them after.
 */
const regressToPreMigrationShape = async (connection) => {
  await connection.query(
    'ALTER TABLE mica_messages_participants DROP INDEX conversation_participant_unique'
  );
  await connection.query(
    'ALTER TABLE mica_messages_participants ADD KEY conversation_participant (conversation_id, citizenid)'
  );

  await connection.query('ALTER TABLE mica_messages_conversations DROP COLUMN pair_key');
  await connection.query('ALTER TABLE mica_messages_conversations DROP COLUMN participant_a');
  await connection.query('ALTER TABLE mica_messages_conversations DROP COLUMN participant_b');
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
    'SELECT COUNT(*) FROM mica_messages_participants WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL',
    [conversationId, citizenid]
  );

const totalCount = (connection, conversationId, citizenid) =>
  scalar(
    connection,
    'SELECT COUNT(*) FROM mica_messages_participants WHERE conversation_id = ? AND citizenid = ?',
    [conversationId, citizenid]
  );

const isGroupOf = (connection, conversationId) =>
  scalar(connection, 'SELECT is_group FROM mica_messages_conversations WHERE id = ?', [
    conversationId
  ]);

/* -------------------------------------------------------------- the run */

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
   * A fresh install must NOT run the migration: `mica.sql` seeds the ledger so every
   * migration is marked applied against tables that were created in their final shape.
   */
  const seeded = await scalar(
    connection,
    'SELECT COUNT(*) FROM mica_schema_migrations WHERE id = ?',
    ['0001_repair_conversation_participants']
  );
  check(`${schemaFile}: a fresh install has the migration pre-seeded`, Number(seeded), 1);

  const seededViewed = await scalar(
    connection,
    'SELECT COUNT(*) FROM mica_schema_migrations WHERE id = ?',
    ['0002_audit_logs_add_viewed_action']
  );
  check(`${schemaFile}: a fresh install has 0002 pre-seeded too`, Number(seededViewed), 1);

  const seeded0003 = await scalar(
    connection,
    'SELECT COUNT(*) FROM mica_schema_migrations WHERE id = ?',
    ['0003_conversations_pair_key']
  );
  check(`${schemaFile}: a fresh install has 0003 pre-seeded too`, Number(seeded0003), 1);

  const seeded0004 = await scalar(
    connection,
    'SELECT COUNT(*) FROM mica_schema_migrations WHERE id = ?',
    ['0004_rename_gphone_tables_to_gos']
  );
  check(`${schemaFile}: a fresh install has 0004 pre-seeded too`, Number(seeded0004), 1);

  const seeded0005 = await scalar(
    connection,
    'SELECT COUNT(*) FROM mica_schema_migrations WHERE id = ?',
    ['0005_rename_gos_tables_to_mica']
  );
  check(`${schemaFile}: a fresh install has 0005 pre-seeded too`, Number(seeded0005), 1);

  const freshRun = await server.runPendingMigrations();
  check(`${schemaFile}: a fresh install applies nothing`, freshRun.applied, []);
  check(`${schemaFile}: a fresh install fails nothing`, freshRun.failed, null);

  step(`${schemaFile} — regressing to a pre-migration server and seeding fixtures`);
  // An existing server has neither the ledger row nor the unique key.
  await connection.query('DELETE FROM mica_schema_migrations');
  await regressToPreMigrationShape(connection);

  const before = await indexesOn(connection, 'mica_messages_participants');
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
    'SELECT updated_at FROM mica_messages_conversations WHERE id = ?',
    [ids.forged]
  );

  step(`${schemaFile} — running the real runPendingMigrations`);
  const result = await server.runPendingMigrations();
  check(`${schemaFile}: reports no failure`, result.failed, null);
  check(`${schemaFile}: applied the migration`, result.applied, [
    '0001_repair_conversation_participants',
    '0002_audit_logs_add_viewed_action',
    '0003_conversations_pair_key',
    '0004_rename_gphone_tables_to_gos',
    '0005_rename_gos_tables_to_mica'
  ]);
  check(`${schemaFile}: nothing left over`, result.remaining, []);

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
    `an audit row with action 'viewed' is accepted, not rejected by the enum`,
    viewedRejected,
    null
  );

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
  const after = await indexesOn(connection, 'mica_messages_participants');
  check(`the unique key is on`, after.includes('conversation_participant_unique (unique)'), true);
  check(`the old index is gone`, after.includes('conversation_participant'), false);

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
  check(`a fresh duplicate is rejected by the database`, rejected, 'ER_DUP_ENTRY');

  const forgedUpdatedAfter = await scalar(
    connection,
    'SELECT updated_at FROM mica_messages_conversations WHERE id = ?',
    [ids.forged]
  );
  check(
    `updated_at is preserved on a row the migration changed`,
    String(forgedUpdatedAfter),
    String(forgedUpdatedAt)
  );

  step(`${schemaFile} — MICA-161: the pair key, backfilled from 0001's own fixtures`);
  const pairRow = async (id) => {
    const [rows] = await connection.query(
      'SELECT participant_a, participant_b, pair_key FROM mica_messages_conversations WHERE id = ?',
      [id]
    );
    return rows[0];
  };

  const genuinePair = await pairRow(ids.genuine);
  check(
    `1. the genuine pair is backfilled, order-independent`,
    [genuinePair.participant_a, genuinePair.participant_b].sort(),
    ['CIT_A', 'CIT_B']
  );
  check(`1. and its pair_key is normalised`, genuinePair.pair_key, 'CIT_A|CIT_B');

  const forgedPair = await pairRow(ids.forged);
  check(
    `2. a thread 0001 flipped to a group gets no pair key`,
    [forgedPair.participant_a, forgedPair.participant_b, forgedPair.pair_key],
    [null, null, null]
  );

  const liveDupesPair = await pairRow(ids.liveDupes);
  check(
    `3. the deduplicated live-duplicates thread still resolves to its real pair`,
    [liveDupesPair.participant_a, liveDupesPair.participant_b].sort(),
    ['CIT_A', 'CIT_VICTIM']
  );

  const closedDupesPair = await pairRow(ids.closedDupes);
  check(
    `4. a pair whose only other member already left keeps a pair key`,
    [closedDupesPair.participant_a, closedDupesPair.participant_b].sort(),
    ['CIT_A', 'CIT_VICTIM2']
  );

  const conversationIndexes = await indexesOn(connection, 'mica_messages_conversations');
  check(
    `${schemaFile}: pair_key_unique is unique — none of 0001's fixtures collide`,
    conversationIndexes.includes('pair_key_unique (unique)'),
    true
  );

  let pairRejected = null;
  try {
    // The exact pair `genuine` already holds, with the two citizenids reversed —
    // `LEAST`/`GREATEST` must still see them as the same pair.
    await connection.query(
      `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
       VALUES (?, 0, ?, ?, 'active')`,
      ['CIT_B', 'CIT_B', 'CIT_A']
    );
  } catch (error) {
    pairRejected = error.code;
  }
  check(`a fresh duplicate pair is rejected by the database`, pairRejected, 'ER_DUP_ENTRY');

  // But a *soft-deleted* duplicate must not block a later, genuinely new active pair —
  // `pair_key`'s CASE only ever gives an `active` row a non-null key, so a deleted row
  // occupies no slot in the unique index for a fresh pair to collide with. A pair with no
  // existing row at all (`CIT_A`/`CIT_EAVESDROPPER` — a group member in `forged`, never a
  // pair on its own), so this cannot be confused with `genuine`'s still-live active row.
  const [deletedDup] = await connection.query(
    `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
     VALUES (?, 0, ?, ?, 'deleted')`,
    ['CIT_A', 'CIT_A', 'CIT_EAVESDROPPER']
  );
  let freshAfterDeleteRejected = null;
  let freshAfterDeleteId = null;
  try {
    const [inserted] = await connection.query(
      `INSERT INTO mica_messages_conversations (citizenid, is_group, participant_a, participant_b, status)
       VALUES (?, 0, ?, ?, 'active')`,
      ['CIT_A', 'CIT_EAVESDROPPER', 'CIT_A']
    );
    freshAfterDeleteId = inserted.insertId;
  } catch (error) {
    freshAfterDeleteRejected = error.code;
  }
  check(
    `a soft-deleted duplicate does not block a fresh active pair`,
    freshAfterDeleteRejected,
    null
  );

  await connection.query('DELETE FROM mica_messages_conversations WHERE id IN (?, ?)', [
    deletedDup.insertId,
    freshAfterDeleteId
  ]);

  step(`${schemaFile} — running it a second time`);
  const rowsBefore = await scalar(connection, 'SELECT COUNT(*) FROM mica_messages_participants');
  const second = await server.runPendingMigrations();
  check(`the ledger stops a second apply`, second.applied, []);
  check(`and reports no failure`, second.failed, null);
  check(
    `no rows changed`,
    Number(await scalar(connection, 'SELECT COUNT(*) FROM mica_messages_participants')),
    Number(rowsBefore)
  );

  /**
   * And once more with the ledger cleared, which is the state a failed ledger write leaves
   * behind — `runMigrations` tells an operator the migration ran but was not recorded, and
   * they have to decide whether to retry. This is that retry.
   */
  await connection.query('DELETE FROM mica_schema_migrations');
  const replay = await server.runPendingMigrations();
  check(`a forced replay still succeeds`, replay.failed, null);
  check(`a forced replay applies cleanly`, replay.applied, [
    '0001_repair_conversation_participants',
    '0002_audit_logs_add_viewed_action',
    '0003_conversations_pair_key',
    '0004_rename_gphone_tables_to_gos',
    '0005_rename_gos_tables_to_mica'
  ]);
  check(
    `a forced replay changes no rows`,
    Number(await scalar(connection, 'SELECT COUNT(*) FROM mica_messages_participants')),
    Number(rowsBefore)
  );
  const replayIndexes = await indexesOn(connection, 'mica_messages_participants');
  check(
    `a forced replay leaves the unique key alone`,
    replayIndexes.includes('conversation_participant_unique (unique)'),
    true
  );
  const replayConversationIndexes = await indexesOn(connection, 'mica_messages_conversations');
  check(
    `a forced replay leaves pair_key_unique alone too`,
    replayConversationIndexes.includes('pair_key_unique (unique)'),
    true
  );
};

/* ---------------------------------- MICA-161: the duplicate-tolerance branch */

/**
 * The one thing `runVariant`'s shared fixtures above cannot exercise: a server that
 * already has more than one active thread for the same pair by the time it upgrades.
 * The decision (`docs/schema-and-services.md`, via the `mica-service` skill) is not to
 * repair that — a merge that mishandles which thread's read state or history is
 * authoritative corrupts something a player can see, silently — so the migration has to
 * *tolerate* it: add `pair_key_unique` as a plain, non-unique index instead of failing
 * `micaschema apply` outright.
 *
 * A dedicated database, the same way `runSweepFixtures` gets its own. The unique-vs-plain
 * decision is table-wide, so proving the plain branch needs a table where a duplicate
 * pair is the *only* thing in it — mixing this into `runVariant`'s shared fixtures would
 * make that function's own "pair_key_unique is unique" assertion false.
 */
const runPairKeyDuplicateFixture = async ({ connection, schemaFile, server }) => {
  const database = 'mica_pairkey_duplicate';
  step(`${schemaFile} — MICA-161: a server with a pre-existing duplicate pair`);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });
  await connection.query(PLAYERS_TABLE);
  await connection.query('INSERT INTO players (citizenid) VALUES (?), (?)', ['CIT_A', 'CIT_B']);
  await connection.query(fs.readFileSync(path.join(root, schemaFile), 'utf8'));

  // A server that has never applied either migration.
  await connection.query('DELETE FROM mica_schema_migrations');
  await regressToPreMigrationShape(connection);

  const conversation = async () => {
    const [result] = await connection.query(
      "INSERT INTO mica_messages_conversations (citizenid, is_group, status) VALUES ('CIT_A', 0, 'active')"
    );
    return result.insertId;
  };
  const participant = async (conversationId, citizenid, role) => {
    await connection.query(
      `INSERT INTO mica_messages_participants (conversation_id, citizenid, role, left_at, status)
       VALUES (?, ?, ?, NULL, 'active')`,
      [conversationId, citizenid, role]
    );
  };

  // The residue `reconcilePairDuplicate`'s post-hoc check could not always catch before
  // `pair_key_unique` existed: two genuinely separate threads, both alive, for the same
  // two people — the ordinary MICA-156 race, from before this fix, left uncleaned.
  const first = await conversation();
  await participant(first, 'CIT_A', 'admin');
  await participant(first, 'CIT_B', 'member');

  const second = await conversation();
  await participant(second, 'CIT_A', 'admin');
  await participant(second, 'CIT_B', 'member');

  const result = await server.runPendingMigrations();
  check(
    `${database}: the migration still succeeds over a pre-existing duplicate`,
    result.failed,
    null
  );
  check(`${database}: it applied every pending migration`, result.applied, [
    '0001_repair_conversation_participants',
    '0002_audit_logs_add_viewed_action',
    '0003_conversations_pair_key',
    '0004_rename_gphone_tables_to_gos',
    '0005_rename_gos_tables_to_mica'
  ]);

  const firstKey = await scalar(
    connection,
    'SELECT pair_key FROM mica_messages_conversations WHERE id = ?',
    [first]
  );
  const secondKey = await scalar(
    connection,
    'SELECT pair_key FROM mica_messages_conversations WHERE id = ?',
    [second]
  );
  check(
    `both threads backfill to the same, real pair key`,
    [firstKey, secondKey],
    ['CIT_A|CIT_B', 'CIT_A|CIT_B']
  );

  const indexes = await indexesOn(connection, 'mica_messages_conversations');
  check(
    `pair_key_unique exists`,
    indexes.some((i) => i.startsWith('pair_key_unique')),
    true
  );
  check(
    `but it is not unique — the migration did not fail, and it did not merge anything`,
    indexes.includes('pair_key_unique (unique)'),
    false
  );

  // Genuinely non-unique, not merely reported as such: a third duplicate must be
  // accepted, because refusing it would be enforcing a constraint the declaration says
  // this server does not actually have.
  let thirdRejected = null;
  try {
    const third = await conversation();
    await participant(third, 'CIT_A', 'admin');
    await participant(third, 'CIT_B', 'member');
  } catch (error) {
    thirdRejected = error.code;
  }
  check(`a third duplicate is accepted rather than refused`, thirdRejected, null);

  // Running it again must neither fail nor try to upgrade the index it already decided
  // not to make unique — `SchemaMigrator`'s planner (and this migration's own
  // `hasIndex` guard) sees `pair_key_unique` present by name and leaves it alone.
  const secondRun = await server.runPendingMigrations();
  check(`a second run reports nothing pending`, secondRun.applied, []);
  check(`and no failure`, secondRun.failed, null);
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

const tableExists = (connection, table) =>
  scalar(
    connection,
    'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );

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

/**
 * MICA-274: 0005 actually moves the rows, which nothing else in this harness proves.
 *
 * `regressToPreMigrationShape` regresses indexes and columns, never the table prefix, so
 * both rename migrations run as no-ops in every other fixture here — they look for a
 * prefix that is not present and return early. That is a green suite that says nothing
 * about the single failure these migrations exist to prevent: a player's messages
 * stranded in a table nothing reads, while an empty one is created beside it and the
 * whole server looks like a fresh install.
 *
 * A dedicated database seeded with `gos_*` tables holding real rows is the only way to
 * see it, and it covers the collision branch in the same pass.
 */
const runPrefixRenameFixture = async ({ connection, schemaFile, server }) => {
  const database = 'mica_prefix_rename';
  step(`${schemaFile} — MICA-274: 0005 carries gos_* rows onto mica_*`);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });
  await connection.query(PLAYERS_TABLE);
  await connection.query('INSERT INTO players (citizenid) VALUES (?)', ['CIT_A']);
  await connection.query(fs.readFileSync(path.join(root, schemaFile), 'utf8'));

  await connection.query(
    "INSERT INTO mica_notes (citizenid, title, content, status) VALUES ('CIT_A', 'survives', 'body', 'active')"
  );
  await connection.query(
    "INSERT INTO mica_contacts (citizenid, firstname, phone, status) VALUES ('CIT_A', 'collides', '555', 'active')"
  );

  // Regress to a pre-micaOS database: the tables carry the old prefix, and the ledger has
  // never seen 0005.
  await connection.query('RENAME TABLE `mica_notes` TO `gos_notes`');
  await connection.query('RENAME TABLE `mica_contacts` TO `gos_contacts`');
  await connection.query('RENAME TABLE `mica_schema_migrations` TO `gos_schema_migrations`');
  await connection.query('CREATE TABLE `mica_schema_migrations` LIKE `gos_schema_migrations`');

  // An operator who started the server once on the new code, so the empty new table is
  // already sitting on the name 0005 wants.
  await connection.query('CREATE TABLE `mica_contacts` LIKE `gos_contacts`');

  const result = await server.runPendingMigrations();
  check(`${schemaFile}: the prefix rename reports no failure`, result.failed, null);
  check(
    `${schemaFile}: 0005 is in the applied list`,
    result.applied.includes('0005_rename_gos_tables_to_mica'),
    true
  );

  check(`${schemaFile}: gos_notes is gone`, Number(await tableExists(connection, 'gos_notes')), 0);
  check(
    `${schemaFile}: its row arrived on mica_notes`,
    Number(await scalar(connection, "SELECT COUNT(*) FROM mica_notes WHERE title = 'survives'")),
    1
  );

  // The collision branch: both names existed, so 0005 leaves the pair alone rather than
  // erroring and aborting the rest of the run.
  check(
    `${schemaFile}: the occupied name is skipped, not clobbered`,
    Number(await tableExists(connection, 'gos_contacts')),
    1
  );
  check(
    `${schemaFile}: and the real rows are still on the old name`,
    Number(
      await scalar(connection, "SELECT COUNT(*) FROM gos_contacts WHERE firstname = 'collides'")
    ),
    1
  );

  // The ledger 0005 is deliberately not moving, because runMigrations is reading the new
  // one while it runs.
  check(
    `${schemaFile}: the old ledger is left where it is`,
    Number(await tableExists(connection, 'gos_schema_migrations')),
    1
  );
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

    // MICA-161. One schema file is enough: the pair-key DDL and the unique-vs-plain
    // decision do not depend on which framework's owner table micaOS is pointed at, unlike
    // the sweep just below, which genuinely differs by framework.
    await runPairKeyDuplicateFixture({ connection, schemaFile: 'mica.sql', server });

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

    await runPrefixRenameFixture({ connection, schemaFile: 'mica.sql', server });

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
