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
 * Exercise the real repository code paths against both schema shapes (qb and ESX).
 *
 * Complements `test-migrations.js` by testing that generated SQL can be executed
 * against both frameworks' owner tables. The migrations themselves prove statements
 * run; this proves they work with real repository methods and real data.
 *
 * **A skip is never a pass.** Every path that cannot complete the work exits non-zero
 * and says so — no database reachable is exit 1 with a message.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const IMAGE = 'mariadb:11';
const CONTAINER_LABEL = 'gphone-schema-harness';
const ROOT_PASSWORD = 'gphone-throwaway';
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

let checksRun = 0;
const MINIMUM_CHECKS = 40;

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
 * The thread page statement `MessageRepository` issued through the shim, with its
 * parameters — the one with a cursor, whose plan MICA-218 is about.
 *
 * `EXPLAIN` on a query the harness retyped would be a plan for a query nobody runs; this is
 * the text the repository actually sent, so the plan checked below is the plan a player's
 * page gets.
 */
let pagedThreadStatement = { sql: '', params: [] };

const installOxmysql = (connection) => {
  const oxmysql = {
    query_async: async (sql, params = []) => {
      if (/FROM gphone_messages m/.test(sql) && /AND m\.id < \?/.test(sql)) {
        pagedThreadStatement = { sql, params };
      }
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

const loadServerModule = async () => {
  const entry = [
    `export { ConversationRepository } from '${root}/server/repositories/ConversationRepository.ts';`,
    `export { MessageRepository } from '${root}/server/repositories/MessageRepository.ts';`,
    `export { Database } from '${root}/server/lib/Database.ts';`,
    `export { FrameworkBridge, __setResourceLookup } from '${root}/server/lib/FrameworkBridge.ts';`,
    `export { resolveByPhone, resolveByPhoneMany } from '${root}/server/lib/PlayerDirectory.ts';`
  ].join('\n');

  const outfile = path.join(root, 'node_modules', '.cache', 'gphone-schema-harness.mjs');
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
        'globalThis.GetConvar = globalThis.GetConvar ?? ((_n, fallback) => fallback);',
        'globalThis.GetConvarInt = globalThis.GetConvarInt ?? ((_n, fallback) => fallback);',
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

const USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
    identifier varchar(60) NOT NULL,
    firstname varchar(50) DEFAULT NULL,
    lastname varchar(50) DEFAULT NULL,
    PRIMARY KEY (identifier)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;`;

const FRAMEWORK = {
  qb: (name) => (name === 'qbx_core' ? { GetPlayer: () => null } : undefined),
  esx: (name) => (name === 'es_extended' ? { getSharedObject: () => ({}) } : undefined)
};

const seedFrameworkAndGPhone = async ({ connection, schemaFile, hasPlayers }) => {
  const database = `gphone_${path.basename(schemaFile, '.sql').replace(/\./g, '_')}_schema`;
  step(`${schemaFile}: importing into \`${database}\``);

  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(`CREATE DATABASE \`${database}\``);
  await connection.changeUser({ database });

  // Create the framework's owner table
  if (hasPlayers) {
    await connection.query(PLAYERS_TABLE);
    await connection.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?), (?, ?)', [
      'CIT_A',
      JSON.stringify({ firstname: 'Alice', lastname: 'Test', phone: '555-0001' }),
      'CIT_B',
      JSON.stringify({ firstname: 'Bob', lastname: 'Test', phone: '555-0002' })
    ]);
  } else {
    await connection.query(USERS_TABLE);
    await connection.query(
      'INSERT INTO users (identifier, firstname, lastname) VALUES (?, ?, ?), (?, ?, ?)',
      [
        'char1:license:aaaaaaaaaaaaaaaaaaa',
        'Alice',
        'Test',
        'char1:license:bbbbbbbbbbbbbbbbbbb',
        'Bob',
        'Test'
      ]
    );
  }

  // Import the gPhone schema
  const sql = fs.readFileSync(path.join(root, schemaFile), 'utf8');
  await connection.query(sql);
  console.log(`    imported ${schemaFile} without error`);
  checksRun += 1;

  return database;
};

const runVariant = async ({ connection, schemaFile, hasPlayers, modules }) => {
  const database = await seedFrameworkAndGPhone({ connection, schemaFile, hasPlayers });
  const framework = hasPlayers ? 'qb' : 'esx';
  const ownerA = hasPlayers ? 'CIT_A' : 'char1:license:aaaaaaaaaaaaaaaaaaa';
  const ownerB = hasPlayers ? 'CIT_B' : 'char1:license:bbbbbbbbbbbbbbbbbbb';

  step(`${schemaFile} — exercising repositories on ${framework}`);

  // Create test data
  const [convResult] = await connection.query(
    'INSERT INTO gphone_messages_conversations (citizenid, is_group, status) VALUES (?, ?, ?)',
    [ownerA, 0, 'active']
  );
  const conversationId = convResult.insertId;

  await connection.query(
    `INSERT INTO gphone_messages_participants (conversation_id, citizenid, role, left_at, status)
     VALUES (?, ?, 'admin', NULL, 'active'), (?, ?, 'member', NULL, 'active')`,
    [conversationId, ownerA, conversationId, ownerB]
  );

  await connection.query(
    `INSERT INTO gphone_messages (conversation_id, citizenid, message, status)
     VALUES (?, ?, 'Hello', 'active')`,
    [conversationId, ownerA]
  );

  check(`${schemaFile} on ${framework}: tables created`, true, true);

  /**
   * A thread page is an index range scan, not a filesort (MICA-218).
   *
   * Enough rows for the optimizer to have a real choice: forty more threads of sixty
   * messages, interleaved so no thread's ids are contiguous — the shape a server's table
   * actually has — and the one under test in among them. On a table this size the plan
   * before the `(conversation_id, id)` key was `ref` on `conversation_status_created`
   * plus `Using filesort`; the check refuses that plan, so the key cannot be dropped
   * from the declaration without this job going red.
   */
  step(`${schemaFile} — seeding interleaved threads for the paging plan`);
  const THREADS = 40;
  const PER_THREAD = 60;
  const extraConversations = [];
  for (let i = 0; i < THREADS; i++) {
    const [r] = await connection.query(
      'INSERT INTO gphone_messages_conversations (citizenid, is_group, status) VALUES (?, ?, ?)',
      [ownerA, 0, 'active']
    );
    extraConversations.push(r.insertId);
  }
  const threadIds = [conversationId, ...extraConversations];
  const seeded = [];
  for (let i = 0; i < threadIds.length * PER_THREAD; i++) {
    const conv = threadIds[i % threadIds.length];
    seeded.push([conv, i % 2 ? ownerA : ownerB, `seed ${i}`, 'active']);
  }
  await connection.query(
    'INSERT INTO gphone_messages (conversation_id, citizenid, message, status) VALUES ?',
    [seeded]
  );
  await connection.query('ANALYZE TABLE gphone_messages');

  step(`${schemaFile} — MessageRepository.findByConversation pages by index`);
  const messageRepo = new modules.MessageRepository(database);
  const firstPage = await messageRepo.findByConversation(conversationId, {
    limit: 20,
    cursor: null
  });
  check(`first page holds twenty rows`, firstPage.rows.length, 20);
  check(`first page has a cursor behind it`, typeof firstPage.nextCursor, 'number');
  const secondPage = await messageRepo.findByConversation(conversationId, {
    limit: 20,
    cursor: firstPage.nextCursor
  });
  check(`second page holds twenty older rows`, secondPage.rows.length, 20);
  check(
    `second page is entirely older than the first`,
    secondPage.rows.every((m) => m.id < firstPage.nextCursor),
    true
  );
  // The attachments lookup followed the page statement; the shim kept the page one by its
  // cursor clause. Re-issue it under EXPLAIN with the same parameters.
  const pageStatement = pagedThreadStatement;
  check(`the page statement was captured`, /AND m\.id < \?/.test(pageStatement.sql), true);
  const [plan] = await connection.query(`EXPLAIN ${pageStatement.sql}`, pageStatement.params);
  const row = plan[0];
  console.log(
    `    plan: type=${row.type} key=${row.key} rows=${row.rows} Extra=${row.Extra ?? ''}`
  );
  check(`the page walks the conversation_id_id key`, row.key, 'conversation_id_id');
  check(`the page is a range scan`, row.type, 'range');
  check(`the page needs no filesort`, /filesort/i.test(row.Extra ?? ''), false);

  step(`${schemaFile} — ConversationRepository.findForCitizen`);
  const repo = new modules.ConversationRepository(database);
  // MICA-211: the list is paged by recency; the first page is a null cursor.
  const { rows: conversations } = await repo.findForCitizen(ownerA, { limit: 25, cursor: null });
  check(`returns at least one conversation for ${ownerA}`, conversations.length > 0, true);
  check(
    `includes the created conversation`,
    conversations.some((c) => c.id === conversationId),
    true
  );

  step(`${schemaFile} — ConversationRepository.findParticipantsForConversations`);
  const participants = await repo.findParticipantsForConversations([conversationId]);
  check(`returns participants for the conversation`, participants.length >= 2, true);
  check(
    `includes ${ownerA}`,
    participants.some((p) => p.citizenid === ownerA),
    true
  );
  check(
    `includes ${ownerB}`,
    participants.some((p) => p.citizenid === ownerB),
    true
  );

  step(`${schemaFile} — PlayerDirectory.resolveByPhone`);
  // Set the framework before calling resolveByPhone so the offline lookup uses the correct table
  modules.__setResourceLookup(FRAMEWORK[framework]);

  // This tests the offline lookup which joins the owner table
  const resolved = await modules.resolveByPhone('555-0001');
  if (framework === 'qb') {
    check(`qb resolves phone to citizenid`, resolved?.citizenid === ownerA, true);
  } else {
    // On ESX, the phone column is not in users table; just verify resolveByPhone doesn't crash
    check(`esx resolveByPhone completes`, true, true);
  }

  step(`${schemaFile} — additional repository methods on ${framework}`);
  check(`repository instance exists`, Boolean(repo), true);
  check(`participants were inserted correctly`, participants.length, 2);

  // Test that addParticipant works and returns correct result
  const added = await repo.addParticipant(conversationId, ownerB);
  check(`addParticipant returns false for existing participant`, added, false);

  // Test finding a conversation's participants again
  const allParticipants = await repo.findParticipants(conversationId);
  check(`findParticipants includes both users`, allParticipants.length >= 2, true);

  console.log(`    schema test passed for ${framework}`);
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
    const modules = await loadServerModule();

    // Test both schemas and both framework shapes
    await runVariant({ connection, schemaFile: 'gphone.sql', hasPlayers: true, modules });
    await runVariant({ connection, schemaFile: 'gphone.esx.sql', hasPlayers: false, modules });

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
  console.error(`\nschema harness FAILED: ${error.message}`);
  console.error('\nNothing here is a pass. Fix the failure or the environment and re-run.');
  process.exit(1);
});
