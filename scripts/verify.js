import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

/**
 * Every gate, one command, in the order that fails soonest.
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
 *   pnpm verify           everything
 *   pnpm verify --quick   everything except e2e and build, for a tight edit loop
 */

const QUICK = process.argv.includes('--quick');
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
      const response = await fetch(`http://localhost:${PORT}/`);
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
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 60_000 });
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

const gate = async (name, command, args, options) => {
  const started = Date.now();
  process.stdout.write(`\n[1m── ${name}[0m\n`);
  const code = await run(command, args, options);
  results.push({ name, code, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  return code;
};

const report = (failedEarly) => {
  process.stdout.write('\n');
  for (const { name, code, seconds } of results) {
    const mark = code === 0 ? '[32m✓[0m' : '[31m✗[0m';
    process.stdout.write(`  ${mark} ${name.padEnd(12)} ${seconds}s\n`);
  }
  if (failedEarly) {
    process.stdout.write(`\n[31mStopped at the first failure.[0m\n`);
  }
  process.stdout.write('\n');
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
  if (await gate('barrels', 'node', ['scripts/generate-barrels.js'])) return (report(true), 1);
  if (await gate('format', 'pnpm', ['format:check'])) return (report(true), 1);
  if (await gate('typecheck', 'pnpm', ['typecheck'])) return (report(true), 1);
  if (await gate('unit', 'pnpm', ['test:unit'])) return (report(true), 1);

  if (QUICK) {
    report(false);
    process.stdout.write('  [2m--quick: skipped e2e and build[0m\n\n');
    return 0;
  }

  // One server for the whole e2e run. Playwright reuses whatever is already on the
  // port, so a `pnpm dev` the developer already had open is used as-is and left alone.
  const borrowed = await portInUse();
  let server;
  if (!borrowed) {
    server = spawn('pnpm', ['--filter', 'web', 'dev'], { stdio: 'ignore', shell: true });
    if (!(await waitForServer())) {
      server.kill();
      process.stdout.write(`\n[31mVite never came up on ${PORT}.[0m\n`);
      return 1;
    }
  }

  const e2e = await gate('e2e', 'pnpm', ['test:e2e']);
  server?.kill();
  if (e2e) return (report(true), 1);

  if (await gate('build', 'pnpm', ['build'])) return (report(true), 1);
  if (await gate('deadcode', 'pnpm', ['deadcode'])) return (report(true), 1);

  report(false);
  return 0;
};

main().then((code) => process.exit(code));
