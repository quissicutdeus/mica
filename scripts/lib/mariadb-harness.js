// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'child_process';
import mysql from 'mysql2/promise';

/**
 * The throwaway MariaDB that `test-schema.js` and `test-endpoints.js` both run against.
 *
 * A Docker container started for the run and stopped after it, or an already-running database
 * named by `MICA_DB_HOST`, `MICA_DB_PORT`, `MICA_DB_USER` and `MICA_DB_PASSWORD` (all four, or
 * none) — which is how CI hands over its service container.
 *
 * **A skip is never a pass.** No Docker, no daemon, half the variables set, or a database that
 * never answers: each one throws with a message saying nothing was tested.
 */

export const IMAGE = 'mariadb:11';
const ROOT_PASSWORD = 'mica-throwaway';
const READY_TIMEOUT = 90_000;

export const step = (message) => console.log(`\n== ${message}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const startContainer = (label) => {
  step(`starting ${IMAGE}`);
  const id = docker([
    'run',
    '--detach',
    '--rm',
    '--label',
    label,
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

const connectWhenReady = async (port) => {
  step('waiting for the server to accept connections');
  const deadline = Date.now() + READY_TIMEOUT;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const config = { host: '127.0.0.1', port, user: 'root', password: ROOT_PASSWORD };
      const connection = await mysql.createConnection({ ...config, multipleStatements: true });
      return { connection, config };
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(
    `the database never became reachable within ${READY_TIMEOUT / 1000}s: ${lastError?.message}`
  );
};

/**
 * A database to run against, and an admin connection to it with `multipleStatements` on — for
 * importing a schema file, never for the code under test.
 *
 * `config` is the host, port and credentials alone, so a harness can open connections of its
 * own. `external` says whether it came from the environment; `close` ends the connection and
 * stops the container, if there is one.
 */
export const openDatabase = async (label) => {
  const host = process.env.MICA_DB_HOST;
  const port = process.env.MICA_DB_PORT;
  const user = process.env.MICA_DB_USER;
  const password = process.env.MICA_DB_PASSWORD;

  if (host || port || user || password) {
    if (!host || !port || !user || !password) {
      throw new Error(
        'all four of MICA_DB_HOST, MICA_DB_PORT, MICA_DB_USER, MICA_DB_PASSWORD ' +
          'must be provided together. Nothing was tested.'
      );
    }
    step('connecting to provided database');
    const config = { host, port: Number(port), user, password };
    const connection = await mysql.createConnection({ ...config, multipleStatements: true });
    console.log(`    connected to ${host}:${port}`);
    return {
      connection,
      config,
      external: true,
      close: async () => {
        await connection.end().catch(() => {});
      }
    };
  }

  assertDockerUsable();
  const container = startContainer(label);
  let ready;
  try {
    ready = await connectWhenReady(container.port);
  } catch (error) {
    stopContainer(container.id);
    throw error;
  }
  const { connection, config } = ready;
  return {
    connection,
    config,
    external: false,
    close: async () => {
      await connection.end().catch(() => {});
      stopContainer(container.id);
    }
  };
};
