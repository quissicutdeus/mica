// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Several `vite build`s of copies of the add-on template, one after another, in one Node.
 *
 * `addonTemplate.test.ts` builds the template nine ways. As nine `vite build` processes each
 * build paid Vite's cold start — loading Vite, the Svelte compiler and the SDK graph's
 * plugins, and JIT-compiling all of it — and that, not the bundling, was most of the file's
 * CPU. In one process the second build onward is warm.
 *
 * Each build is what `vite build [--mode m] [--outDir d]` does, and no more: the CLI's
 * `build` action hands `createBuilder` exactly this inline config (`root` unset, so the
 * working directory; every build flag that is not a global one under `build`), calls
 * `buildApp()` and `runDevTools()`, and on a throw logs `error during build:` with the
 * error inspected and exits 1. The two things a fresh process would start with and a build
 * changes are put back before each one: the working directory, and the environment —
 * Vite sets `NODE_ENV` the first time it resolves a config, and the next build would read
 * it as the caller's.
 *
 * Usage: `node addonTemplateBuilds.mjs <jobs.json> <results.json>`, where a job is
 * `{ name, dir, mode, build }` and a result is `{ code, output }` under the job's name.
 * Everything a build writes to stdout or stderr is its `output`.
 */

import fs from 'node:fs';
import module from 'node:module';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { createBuilder, createLogger } from 'vite';

const [jobsFile, resultsFile] = process.argv.slice(2);
if (!jobsFile || !resultsFile) {
  console.error('usage: node addonTemplateBuilds.mjs <jobs.json> <results.json>');
  process.exit(2);
}

/** @type {{ name: string, dir: string, mode: string, build: Record<string, unknown> }[]} */
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));

// As `vite`'s own bin does before it loads the CLI.
module.enableCompileCache?.();

const startingEnv = { ...process.env };
const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in startingEnv)) delete process.env[key];
  }
  Object.assign(process.env, startingEnv);
};

/** Every write to stdout and stderr goes to `sink` while a build runs. */
let sink = /** @type {string[] | null} */ (null);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = /** @type {typeof stream.write} */ (
    (chunk, ...rest) => {
      if (sink === null) return write(chunk, ...rest);
      sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const done = rest.find((arg) => typeof arg === 'function');
      if (done) done();
      return true;
    }
  );
}

/** @type {Record<string, { code: number, output: string }>} */
const results = {};
for (const { name, dir, mode, build } of jobs) {
  resetEnv();
  process.chdir(dir);
  globalThis.__vite_start_time = performance.now();
  const output = [];
  sink = output;
  let code = 0;
  try {
    const builder = await createBuilder(
      {
        root: undefined,
        base: undefined,
        mode,
        configFile: undefined,
        configLoader: undefined,
        logLevel: undefined,
        clearScreen: undefined,
        build
      },
      null
    );
    await builder.buildApp();
    await builder.runDevTools();
  } catch (e) {
    createLogger(undefined).error(`error during build:\n${inspect(e)}`, { error: e });
    code = 1;
  }
  sink = null;
  results[name] = { code, output: output.join('') };
}

fs.writeFileSync(resultsFile, JSON.stringify(results));
// A build that failed may hold a handle open; the CLI would have exited on it.
process.exit(0);
