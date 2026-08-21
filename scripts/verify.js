import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

/**
 * Every gate, one command, cheapest first.
 *
 * AGENTS.md §9 asks for five checks by exit code, which meant five invocations, five
 * startups, and remembering the list. It also meant CI ran a different set from the one
 * the docs describe — `test:unit` and `build`, so seventy-one e2e tests and the
 * formatter were enforced nowhere.
 *
 * The e2e step is why this is a script rather than a chain of `&&`. Playwright starts
 * its own Vite server when none is running, and that cold start costs about two and a
 * half minutes against twenty-seven seconds warm — six times the wall clock, paid on
 * every run. Starting one server up front and letting `reuseExistingServer` find it
 * gets that back.
 *
 * Every gate runs, and the report at the end names all of them. It used to stop at the
 * first failure, which quietly made the later gates unreachable on any machine where an
 * earlier one was unhappy: `deadcode` sits behind `e2e`, three home-grid drag specs fail
 * locally under full-suite load (they pass in CI), and so a knip failure rode `main` for
 * four commits because the only step that catches it could never be reached from a
 * developer's terminal. A gate nobody can run is not a gate. Use `--bail` for the old
 * stop-at-first behaviour during a tight edit loop.
 *
 *   pnpm verify           every gate, every failure reported
 *   pnpm verify --quick   skips e2e only — what pre-push runs
 *   pnpm verify --bail    stop at the first failing gate
 */

const QUICK = process.argv.includes('--quick');
const BAIL = process.argv.includes('--bail');
const PORT = Number(process.env.PORT ?? 5173);

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, ...options });
    child.on('close', (code) => resolve(code ?? 1));
  });

const portInUse = () =>
  new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(true))
      .once('listening', () => probe.close(() => resolve(false)))
      .listen(PORT);
  });

const waitForHtml = async (timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/**
 * A raw fetch of `/` only proves index.html is served — Vite transforms a module the
 * first time something actually imports it, which for a Svelte app means walking the
 * whole component graph, and only a real module-executing client does that. Skipping
 * this used to let the e2e gate start against a dev server that was up but still cold:
 * Playwright's ~16 parallel workers would then all hit that cold server at once, each
 * transform request queuing behind the others, and dozens of unrelated specs would time
 * out at 30s not because anything was broken but because the server hadn't finished
 * compiling by the time they asked. A real navigation forces the whole graph the app's
 * first screen needs to compile before any test worker starts.
 */
const warmServer = async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60_000 });
  } finally {
    await browser.close();
  }
};

const waitForServer = async (timeoutMs = 60_000) => {
  if (!(await waitForHtml(timeoutMs))) return false;
  await warmServer();
  return true;
};

const results = [];

/** Every gate in the order it runs. Only used to report the ones that did not. */
const GATES = ['format', 'typecheck', 'unit', 'e2e', 'build', 'deadcode'];

const gate = async (name, command, args, options) => {
  const started = Date.now();
  process.stdout.write(`\n[1m── ${name}[0m\n`);
  const code = await run(command, args, options);
  results.push({ name, code, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  return code;
};

/**
 * `skipped` is listed rather than omitted: a gate that did not run is not a gate that
 * passed, and the two were indistinguishable in this summary — which is much of why a
 * failing `deadcode` went unnoticed for as long as it did.
 */
const report = ({ bailed = false, skipped = [] } = {}) => {
  process.stdout.write('\n');
  for (const { name, code, seconds } of results) {
    const mark = code === 0 ? '[32m✓[0m' : '[31m✗[0m';
    process.stdout.write(`  ${mark} ${name.padEnd(12)} ${seconds}s\n`);
  }
  for (const name of skipped) {
    process.stdout.write(`  [2m· ${name.padEnd(12)} skipped[0m\n`);
  }

  const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
  process.stdout.write('\n');
  if (failed.length > 0) {
    process.stdout.write(`[31m${failed.length} failed: ${failed.join(', ')}[0m\n`);
    if (bailed) process.stdout.write(`[2m--bail: stopped at the first failure.[0m\n`);
    process.stdout.write('\n');
  }
};

/** Cheapest first, so a missing semicolon does not cost a full e2e run to discover. */
const main = async () => {
  // The generated barrels, before anything reads them.
  //
  // `pnpm new:app <id> --service` writes `web/src/sdk/hooks/use<Name>.ts`, and that
  // directory's `index.ts` is generated — previously only by `build` and `watch`, which
  // run *after* typecheck here. So a freshly scaffolded app died at the typecheck gate on
  // an import that was perfectly correct, and the remedy was a command nothing mentioned.
  // `.vscode/settings.json` marks the barrel read-only, so fixing it by hand was blocked
  // too. Idempotent and about a millisecond, so it runs every time rather than becoming
  // one more thing to remember.
  // The generated barrels are a prerequisite, not a gate, so this one still stops the run:
  // every check below reads the files it writes, and their failures would all be about
  // missing imports rather than about anything the developer changed.
  if (await gate('barrels', 'node', ['scripts/generate-barrels.js'])) {
    report({ bailed: true });
    return 1;
  }

  // `--bail` restores stop-at-first for a tight edit loop. The default runs everything:
  // see the note at the top of this file for what hiding late gates behind early ones
  // cost.
  const stop = () => BAIL && results.some((r) => r.code !== 0);

  if (!stop()) await gate('format', 'pnpm', ['format:check']);
  if (!stop()) await gate('typecheck', 'pnpm', ['typecheck']);
  if (!stop()) await gate('unit', 'pnpm', ['test:unit']);

  // e2e is the only gate `--quick` drops, and the only one that costs minutes rather than
  // seconds. `build` and `deadcode` stay: between them they are about fifteen seconds, and
  // `deadcode` is exactly the gate that rode main red for four commits precisely because
  // nothing before CI ever ran it. pre-push is the last place to catch that cheaply.
  if (QUICK) {
    // nothing to do — the summary derives `e2e` as skipped from GATES below.
  } else if (!stop()) {
    // One server for the whole e2e run. Playwright reuses whatever is already on the
    // port, so a `pnpm dev` the developer already had open is used as-is and left alone.
    const borrowed = await portInUse();
    let server;
    if (!borrowed) {
      server = spawn('pnpm', ['--filter', 'web', 'dev'], { stdio: 'ignore', shell: true });
      if (!(await waitForServer())) {
        server.kill();
        process.stdout.write(`\n[31mVite never came up on ${PORT}.[0m\n`);
        report({ skipped: ['e2e', 'build', 'deadcode'] });
        return 1;
      }
    }
    await gate('e2e', 'pnpm', ['test:e2e']);
    server?.kill();
  }

  if (!stop()) await gate('build', 'pnpm', ['build']);
  if (!stop()) await gate('deadcode', 'pnpm', ['deadcode']);

  // Derived from the plan rather than tracked as it goes, so a gate skipped by `--quick`
  // and a gate cut short by `--bail` are reported the same way and in the same order they
  // would have run.
  const ran = new Set(results.map((r) => r.name));
  const skipped = GATES.filter((name) => !ran.has(name));

  const failed = results.some((r) => r.code !== 0);
  report({ bailed: BAIL && failed, skipped });
  return failed ? 1 : 0;
};

main().then((code) => process.exit(code));
