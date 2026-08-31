import { spawn } from 'node:child_process';

/**
 * Every gate, one command, cheapest first.
 *
 * AGENTS.md §9 asks for five checks by exit code, which meant five invocations, five
 * startups, and remembering the list. It also meant CI ran a different set from the one
 * the docs describe — `test:unit` and `build`, so seventy-one e2e tests and the
 * formatter were enforced nowhere.
 *
 * It used to manage the e2e server itself, for a cold-start cost that no longer exists:
 * the suite now builds a bundle and serves that (web/playwright.config.ts), so there is
 * no on-demand compilation to warm up and Playwright owns the server. What remains here
 * is the reporting — running every gate and naming all of them.
 *
 * Every gate runs, and the report at the end names all of them. It used to stop at the
 * first failure, which quietly made the later gates unreachable on any machine where an
 * earlier one was unhappy: `deadcode` sits behind `e2e`, and so a knip failure rode `main`
 * for four commits because the only step that catches it could never be reached from a
 * developer's terminal. A gate nobody can run is not a gate. Use `--bail` for the old
 * stop-at-first behaviour during a tight edit loop.
 *
 *   pnpm verify           every gate, every failure reported
 *   pnpm verify --quick   skips e2e only — what pre-push runs
 *   pnpm verify --bail    stop at the first failing gate
 */

const QUICK = process.argv.includes('--quick');
const BAIL = process.argv.includes('--bail');
/**
 * Drop the `container` gate, for the one caller that has something better.
 *
 * This gate is cheap where it cannot run and expensive where it can: inside a container
 * with no Docker daemon it reports skipped in under a second, but on a plain runner it
 * finds Docker, pulls golang:1-alpine and hadolint, and spends ~30s reaching a verdict
 * that CI's `container` job has already reached properly — that job installs the real
 * toolchains and passes `--require`, which is the only place a skip is an error.
 *
 * So this exists for that workflow and not as a general escape hatch. It is safe there
 * precisely because something else is failing the build when these checks cannot run;
 * it would not be safe as a habit, and the summary still lists `container` as skipped
 * rather than dropping it, for the reason `skipped` is printed at all.
 */
const NO_CONTAINER = process.argv.includes('--no-container');

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, ...options });
    child.on('close', (code) => resolve(code ?? 1));
  });

const results = [];

/** Every gate in the order it runs. Only used to report the ones that did not. */
const GATES = [
  'format',
  'markdown',
  'agents',
  'container',
  'lint',
  'typecheck',
  'unit',
  'e2e',
  'build',
  'deadcode'
];

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
  // `pnpm new:app <id> --service` writes `sdk/host/use<Name>.ts`, and that
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
  if (!stop()) await gate('markdown', 'pnpm', ['lint:md']);

  // AGENTS.md's size, in about a millisecond. It is here rather than in the unit suite for
  // one reason: `check:fast` selects tests from the git diff, and Vitest would never pick a
  // test file out of a change that only touched AGENTS.md — so the gate that exists to
  // catch that change would be the one gate that change could not run.
  if (!stop()) await gate('agents', 'pnpm', ['lint:agents']);

  // The Go server and the Dockerfile, which `format:check` cannot read — Prettier has no
  // parser for either. Cheap, and second only to `format` because a `gofmt` diff should
  // not cost a full unit run to discover.
  //
  // Reports a missing `go` or `hadolint` as skipped rather than failing, so this does not
  // put a Go toolchain between a Svelte change and a push. CI passes --require, which is
  // what stops "skipped locally" from silently becoming "skipped everywhere".
  if (!stop() && !NO_CONTAINER) await gate('container', 'pnpm', ['lint:container']);
  if (!stop()) await gate('lint', 'pnpm', ['lint']);
  if (!stop()) await gate('typecheck', 'pnpm', ['typecheck']);
  if (!stop()) await gate('unit', 'pnpm', ['test:unit']);

  // e2e is the only gate `--quick` drops, and the only one that costs minutes rather than
  // seconds. `build` and `deadcode` stay: between them they are about fifteen seconds, and
  // `deadcode` is exactly the gate that rode main red for four commits precisely because
  // nothing before CI ever ran it. pre-push is the last place to catch that cheaply.
  if (QUICK) {
    // nothing to do — the summary derives `e2e` as skipped from GATES below.
  } else if (!stop()) {
    // Playwright owns the server now.
    //
    // This used to start `pnpm --filter web dev` here and drive a real browser navigation
    // to force Vite to compile the whole graph before any worker asked for it. That
    // existed because the suite ran against a dev server that transforms on demand, and
    // several minutes of a run were spent on the resulting stampede. The suite builds a
    // bundle first now (web/playwright.config.ts), so there is nothing to warm and no
    // reason for this file to know about ports at all.
    //
    // It also removes a crash: `chromium.launch()` failing here — no browsers downloaded,
    // or downloaded onto a host missing their shared libraries — threw past this function
    // and killed the run, taking `build` and `deadcode` with it. Playwright reports that
    // as an ordinary gate failure.
    await gate('e2e', 'pnpm', ['test:e2e']);
  }

  // `build:nocheck`, not `build`: `pnpm build` runs `pnpm typecheck` itself, and the
  // typecheck gate above already ran exactly that, on exactly this tree, seconds earlier.
  // Paying for it twice cost ~10s of every run and every CI minute to prove a thing that
  // was already proved. The gate is still named `build` because what it verifies is
  // unchanged: that esbuild and Vite can actually produce the bundles. `pnpm build` on
  // its own keeps its typecheck -- outside this script nothing else has run one.
  if (!stop()) await gate('build', 'pnpm', ['build:nocheck']);
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
