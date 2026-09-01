// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
 *   pnpm verify --force   ignore the cache and run every gate cold
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

/**
 * Serve a gate from cache when its inputs have not changed since it last passed.
 *
 * The thing being fixed is not a slow gate, it is a re-run that proves nothing. Rewrap a
 * paragraph of Markdown and the honest answer for `e2e` is the answer it gave ninety
 * seconds ago; nothing about a changed `.md` can reach Playwright. AGENTS.md §9's table
 * already asks a person to match the gate to the change by hand, and doing it by hand turns
 * out to be exactly the judgement that lapses under time pressure — so this reads it off the
 * file list instead of asking anyone to remember.
 *
 * Deliberately paranoid, because a cache that wrongly says "unchanged" is this repo's
 * least favourite failure: a gate that did not run, reading as a gate that passed.
 *
 *   - **Any config change serves nothing from cache** — a `package.json`, the lockfile, a
 *     tsconfig, any `*.config.*`, or anything under `scripts/`, `build/`, `.github/` or
 *     `.claude/`. These are the files whose effects are not confined to where they live, so
 *     reasoning about them gate by gate is precisely the mistake.
 *   - **Each gate's input set is a superset of what it reads.** `e2e` is invalidated by
 *     anything under `web/`, `sdk/` or `shared/`, far more than the specs touch. A run
 *     skipped that was needed costs correctness; a run made that was not costs seconds.
 *   - **Content, not timestamps**, so restoring an old file is not mistaken for stillness
 *     and a `touch` is not mistaken for a change.
 *   - **Untracked files count.** `--others --exclude-standard` is in the listing, because a
 *     new unstaged test file is exactly what a cache must not shrug at.
 *   - **The cheap gates are never cached.** `format`, `markdown`, `agents` and `deadcode`
 *     come to about six seconds between them; caching them buys nothing and adds a way to
 *     be wrong. A gate missing from `GATE_INPUTS` is never served, which is also the right
 *     default for one added later by someone who has not thought about its inputs yet.
 *   - **CI never caches**, nor does `--force`. A fresh checkout has no cache file anyway;
 *     the `CI` check makes that a guarantee rather than a coincidence.
 *
 * A served gate prints `cached` rather than the tick a real run earns — the same reason
 * `skipped` is printed rather than omitted further down. The reader has to be able to tell
 * what actually ran.
 */
const FORCE = process.argv.includes('--force');
const CACHING = !FORCE && !process.env.CI;
const CACHE_FILE = 'node_modules/.cache/verify/state.json';

/** Files whose blast radius is the whole repo. One of these changes and nothing is served. */
const isConfig = (p) =>
  /(^|\/)package\.json$/.test(p) ||
  /(^|\/)tsconfig[^/]*\.json$/.test(p) ||
  /\.config\.(ts|js|mjs|cjs)$/.test(p) ||
  /^(scripts|build|\.github|\.claude)\//.test(p) ||
  ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'knip.jsonc', 'Dockerfile', 'compose.yaml'].includes(p);

/** What each cacheable gate reads, drawn wide on purpose. */
const GATE_INPUTS = {
  container: (p) =>
    p.startsWith('docker/') || p === 'Dockerfile' || p === 'compose.yaml' || p.endsWith('.go'),
  lint: (p) => /\.(ts|js|mjs|cjs|svelte)$/.test(p),
  typecheck: (p) => /\.(ts|svelte)$/.test(p),
  unit: (p) => /\.(ts|svelte)$/.test(p),
  e2e: (p) => /^(web|sdk|shared)\//.test(p),
  build: (p) => /^(client|server|web|sdk|shared)\//.test(p)
};

/** Tracked files plus untracked-but-not-ignored ones, so a new file is never invisible. */
const repoFiles = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)
    .sort();

const hashFiles = (paths) => {
  const h = createHash('sha256');
  for (const p of paths) {
    h.update(p);
    h.update('\0');
    try {
      h.update(readFileSync(p));
    } catch {
      // Deleted between listing and reading, or unreadable. Feed that in rather than
      // ignoring it, so it still reads as a change.
      h.update('<unreadable>');
    }
    h.update('\0');
  }
  return h.digest('hex');
};

const files = CACHING ? repoFiles() : [];
const configHash = CACHING ? hashFiles(files.filter(isConfig)) : null;
const previous = (() => {
  if (!CACHING) return { config: null, gates: {} };
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { config: null, gates: {} };
  }
})();
const configUnchanged = CACHING && previous.config === configHash;
const nextGates = configUnchanged ? { ...previous.gates } : {};

/**
 * The hash identifying this gate's inputs, or null if the gate is never cacheable.
 *
 * Note what this deliberately does *not* consult: `configUnchanged`. Recording a hash and
 * trusting one are different questions, and folding them together here meant a cold run —
 * where there is no previous config to match, so `configUnchanged` is false — computed no
 * keys and therefore stored none. The cache could never be populated by the run that
 * should populate it, and the whole thing silently did nothing while looking correct.
 * Storing is unconditional; serving is what has to be careful, and that lives in `gate`.
 */
const gateKey = (name) => {
  if (!CACHING) return null;
  const reads = GATE_INPUTS[name];
  return reads ? hashFiles(files.filter(reads)) : null;
};

const saveCache = () => {
  if (!CACHING) return;
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ config: configHash, gates: nextGates }));
  } catch {
    // A cache that cannot be written is a slower run, not a wrong one.
  }
};

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
  const key = gateKey(name);
  // Serving is the careful half: the config must be untouched *and* this gate's own inputs
  // must match what they were when it last passed. Storing, below, needs neither.
  if (key !== null && configUnchanged && previous.gates?.[name] === key) {
    process.stdout.write(
      `\n[1m── ${name}[0m [2m(cached — inputs unchanged since it last passed)[0m\n`
    );
    results.push({ name, code: 0, seconds: '0.0', cached: true });
    return 0;
  }

  const started = Date.now();
  process.stdout.write(`\n[1m── ${name}[0m\n`);
  const code = await run(command, args, options);
  results.push({ name, code, seconds: ((Date.now() - started) / 1000).toFixed(1) });

  // Only a gate that actually passed is worth remembering. A failing one is left out, so
  // the next run has to earn its verdict again rather than inheriting a stale one.
  if (key !== null && code === 0) nextGates[name] = key;
  return code;
};

/**
 * `skipped` is listed rather than omitted: a gate that did not run is not a gate that
 * passed, and the two were indistinguishable in this summary — which is much of why a
 * failing `deadcode` went unnoticed for as long as it did.
 */
const report = ({ bailed = false, skipped = [] } = {}) => {
  process.stdout.write('\n');
  for (const { name, code, seconds, cached } of results) {
    // A cached gate gets its own mark and the word, never the tick. It did not run, and
    // the entire reason `skipped` is printed below is that "did not run" and "passed" must
    // not look alike in this summary.
    if (cached) {
      process.stdout.write(`  [36m◇[0m ${name.padEnd(12)} [2mcached[0m\n`);
      continue;
    }
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

  // Written after every run, including a failing one: the gates that passed on this tree
  // still passed, and there is no reason to make them prove it again on the next attempt
  // just because something else was red. A gate that failed was never added to `nextGates`.
  saveCache();

  report({ bailed: BAIL && failed, skipped });
  return failed ? 1 : 0;
};

main().then((code) => process.exit(code));
