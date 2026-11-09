// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';

/**
 * Which of the real-MariaDB gates `scripts/verify.js` can run, and what to say about the
 * ones it cannot (MICA-465).
 *
 * `server/__tests__/` mocks `Database` throughout, so a server change used to meet real SQL
 * for the first time in CI's `schema` and `endpoints` jobs, after the push. These gates bring
 * that forward when a database can be had, and are **loud when it cannot**: a gate that did
 * not run is reported as NOT RUN with its reason, never omitted and never ticked. That is the
 * whole point of the split between `run` and `notRun` below.
 *
 * Lives here rather than in `verify.js` for the reason `gate-env.js` does: `verify.js` runs
 * its gates on import, so anything that decides a plan has to be importable to be tested.
 */

/** The four variables the harness reads (`scripts/lib/mariadb-harness.js`). */
export const DB_ENV_VARS = ['MICA_DB_HOST', 'MICA_DB_PORT', 'MICA_DB_USER', 'MICA_DB_PASSWORD'];

/** Every real-database gate, in the order they run. `optIn` ones need `--migrations`. */
export const DB_GATES = [
  { name: 'schema', script: 'test:schema', seconds: 50 },
  { name: 'endpoints', script: 'test:endpoints', seconds: 10 },
  { name: 'migrations', script: 'test:migrations', seconds: 300, optIn: true }
];

/**
 * Can a database be had? Either one is named in the environment (CI hands over a service
 * container that way), or Docker's *daemon* answers -- `docker info`, not `docker --version`,
 * which prints happily with the daemon down (the same probe `lint-container.js` makes).
 *
 * Any one of the four variables counts as "named": a half-set group is not reachable, but it
 * is the harness that must reject it, loudly, rather than this probe quietly calling it
 * absent.
 *
 * Returns `{ ok, via }` or `{ ok: false, reason }`. `spawn` is injectable for the test.
 */
export const databaseAvailable = (env = process.env, spawn = spawnSync) => {
  if (DB_ENV_VARS.some((name) => env[name]))
    return { ok: true, via: 'MICA_DB_* in the environment' };
  const probe = spawn('docker', ['info'], { stdio: 'ignore', env, timeout: 20_000 });
  if (probe.status === 0) return { ok: true, via: 'docker' };
  const why = probe.error
    ? `docker is not usable (${probe.error.code ?? probe.error.message})`
    : 'the docker daemon is not reachable (`docker info` failed)';
  return { ok: false, reason: why };
};

/**
 * The plan: `run` gates to execute in order, `notRun` ones to print loudly (each with the
 * reason), `skipped` ones the caller asked to drop (`--no-db`).
 *
 * `--no-db` is for the one caller that has something better, as `--no-container` is: CI's
 * `verify` job, whose sibling `schema` and `endpoints` jobs run these against a service
 * container. It is listed as skipped rather than dropped from the summary.
 */
export const planDbGates = ({
  noDb = false,
  migrations = false,
  probe = databaseAvailable
} = {}) => {
  const plan = { run: [], notRun: [], skipped: [] };
  if (noDb) {
    plan.skipped = DB_GATES.map((g) => g.name);
    return plan;
  }
  const available = probe();
  for (const g of DB_GATES) {
    if (g.optIn && !migrations) {
      plan.notRun.push({
        name: g.name,
        reason: `opt-in, ~${g.seconds}s: pass --migrations to run it (also: pnpm ${g.script})`
      });
    } else if (!available.ok) {
      plan.notRun.push({ name: g.name, reason: `${available.reason}; nothing was tested` });
    } else {
      plan.run.push(g);
    }
  }
  return plan;
};
