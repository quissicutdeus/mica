import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

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

const waitForServer = async (timeoutMs = 60_000) => {
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
