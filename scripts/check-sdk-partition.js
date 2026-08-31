#!/usr/bin/env node
/**
 * MICA-184. The SDK's pure-TypeScript core is checked by TypeScript 7, and this proves
 * the set of files that gets that treatment is exactly the right one.
 *
 * `sdk/` contains 85 `.svelte` files, so it needs `svelte-check`, which needs `svelte2tsx`,
 * which needs a stable programmatic compiler API that does not land until TypeScript 7.1
 * (AGENTS.md §3). But only five of the package's 170 non-test `.ts` files actually reach a
 * `.svelte` — the barrels `index.ts`, `addon.ts`, `core.ts`, `components.ts`, `icons.ts`.
 * The other 165 are ordinary TypeScript and are held to the same TS 7 that already checks
 * `client/` and `server/`, through `sdk/tsconfig.tsc.json`.
 *
 * ## This is additive, and that is worth being exact about
 *
 * `svelte-check` still checks the whole package, as it always did. Narrowing its `include`
 * to the barrels was tried and is a no-op: its program is the transitive closure of the
 * `.svelte` files, so the pure core comes in as their dependencies and still reports
 * diagnostics — 823 files either way, and an error injected into an "excluded" file is
 * still caught. Config that looked like a partition while behaving identically to the
 * broad one would be a check that reads as something it is not, so there is only one
 * declared list: the `exclude` in `sdk/tsconfig.tsc.json`.
 *
 * It follows that **no file can ever lose typechecking**. What a file can lose is the
 * *stricter* TS 7 pass, and that loss is silent — which is what this gate is for.
 *
 * ## Why neither compiler can be this gate
 *
 * Both directions of drift are silent. That is measured, not assumed:
 *
 * - A file on the **TS 7 side that starts importing a `.svelte`** does NOT fail, though it
 *   was assumed it would on the reasoning that tsc cannot resolve `./Foo.svelte`. It can:
 *   `svelte/types/index.d.ts` carries `declare module '*.svelte'`, and `sdk/env.d.ts` pulls
 *   it in ambiently via `/// <reference types="svelte" />`. The import resolves to
 *   `ComponentType<SvelteComponent>` and tsc exits 0, having typechecked a component as an
 *   opaque blob.
 * - A file that **stops reaching a `.svelte` but stays in the `exclude` list** does not fail
 *   either, for the obvious reason: it is still being checked, just by the weaker compiler.
 *
 * A hand-maintained `exclude` list is the version of this that rots. So this gate *derives*
 * the split by resolving imports and asserts the list agrees with it exactly, in both
 * directions — a file wrongly excluded, and a file wrongly included.
 *
 * ## How it decides
 *
 * Reachability is transitive over static imports, re-exports and dynamic `import()`, read
 * with TypeScript's own `preProcessFile` rather than a regex — a regex reads the code fences
 * in this package's doc comments as real imports and reports `app.ts` on the svelte side,
 * which it is not.
 *
 * The file set each config claims is read back from `ts.parseJsonConfigFileContent`, i.e.
 * from TypeScript itself, so editing a glob in either config cannot fool this check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// TS 6, aliased at the root precisely so a programmatic compiler API is available while
// root's bare `typescript` is 7.x (which does not ship one until 7.1).
const ts = createRequire(import.meta.url)('typescript-ast-parser');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = path.join(ROOT, 'sdk');
const rel = (f) => path.relative(SDK, f).split(path.sep).join('/');

const SVELTE_EXT = [
  { extension: '.svelte', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }
];

/** Every source file the package owns, as tsc would see it: on disk, minus installs. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(SDK);
const svelteFiles = all.filter((f) => f.endsWith('.svelte'));
const dtsFiles = all.filter((f) => f.endsWith('.d.ts'));
const tsFiles = all.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
const nonTestTs = tsFiles.filter((f) => !f.endsWith('.test.ts'));

// --- module resolution, narrow on purpose --------------------------------------------
// Only the specifier forms this package actually uses. A bare package name is external and
// can never reach a `.svelte` in this tree, so it terminates the walk.
const PATHS = {
  '@gphone/sdk': path.join(SDK, 'index.ts'),
  '@gphone/sdk/app': path.join(SDK, 'app.ts'),
  '@gphone/sdk/core': path.join(SDK, 'core.ts'),
  '@gphone/sdk/testing': path.join(ROOT, 'web/src/testing.ts')
};
const onDisk = new Set(all);
const exists = (f) => onDisk.has(f) || fs.existsSync(f);

function candidates(base) {
  return [
    base,
    `${base}.ts`,
    `${base}.svelte`,
    base.replace(/\.js$/, '.ts'),
    `${base}.js`,
    path.join(base, 'index.ts')
  ];
}
function resolveSpecifier(spec, from) {
  if (PATHS[spec]) return PATHS[spec];
  const base = spec.startsWith('@gphone/shared/')
    ? path.join(ROOT, 'shared', spec.slice('@gphone/shared/'.length))
    : spec.startsWith('.')
      ? path.resolve(path.dirname(from), spec)
      : null;
  if (base === null) return null; // bare package: external
  for (const c of candidates(base)) if (exists(c) && fs.statSync(c).isFile()) return c;
  return null;
}

const importCache = new Map();
function importsOf(file) {
  let v = importCache.get(file);
  if (v === undefined) {
    v = ts
      .preProcessFile(fs.readFileSync(file, 'utf8'), true, true)
      .importedFiles.map((i) => i.fileName);
    importCache.set(file, v);
  }
  return v;
}

const unresolved = [];
const reachCache = new Map();
function reachesSvelte(file, stack = []) {
  if (file.endsWith('.svelte')) return true;
  const cached = reachCache.get(file);
  if (cached !== undefined) return cached;
  // A cycle contributes nothing on its own: whatever the loop reaches is reached by some
  // other edge out of it, and that edge is still walked.
  if (stack.includes(file)) return false;
  let hit = false;
  for (const spec of importsOf(file)) {
    const target = resolveSpecifier(spec, file);
    if (target === null) {
      if (/^(\.|@shared\/|@gphone\/)/.test(spec)) unresolved.push(`${rel(file)} -> ${spec}`);
      continue;
    }
    if (target.endsWith('.css')) continue;
    if (reachesSvelte(target, [...stack, file])) hit = true;
  }
  reachCache.set(file, hit);
  return hit;
}

/** The computed truth: non-test `.ts` files that transitively reach a `.svelte`. */
const reaching = nonTestTs.filter((f) => reachesSvelte(f)).sort();

// --- what each config actually claims -------------------------------------------------
function filesOf(configName) {
  const configPath = path.join(SDK, configName);
  const read = ts.readConfigFile(configPath, (p) => fs.readFileSync(p, 'utf8'));
  if (read.error) {
    throw new Error(
      `${configName}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    SDK,
    undefined,
    configPath,
    undefined,
    SVELTE_EXT
  );
  const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    throw new Error(
      `${configName}: ${fatal.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`
    );
  }
  return new Set(parsed.fileNames.map((f) => path.normalize(f)));
}

const tscSet = filesOf('tsconfig.tsc.json');
const svelteSet = filesOf('tsconfig.json');

// --- assertions -----------------------------------------------------------------------
const problems = [];
const sourcesIn = (set) =>
  new Set(
    [...set].filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || f.endsWith('.svelte'))
  );

if (unresolved.length > 0) {
  // Not a warning. An import this gate cannot follow is a hole in the reachability walk, so
  // the answer it produced is not trustworthy and must not be reported as a pass.
  for (const u of unresolved)
    problems.push(`unresolvable relative import, reachability is incomplete: ${u}`);
}

// 1. The TS 7 side, exactly: every non-test `.ts` that does not reach a `.svelte`, and
//    nothing else. Both directions — a file wrongly excluded loses TS 7 silently, and a
//    file wrongly included would be typechecking a component as an opaque blob.
const reachingSet = new Set(reaching);
const expectedTsc = new Set(nonTestTs.filter((f) => !reachingSet.has(f)));
const actualTsc = sourcesIn(tscSet);
for (const f of [...actualTsc].filter((x) => !expectedTsc.has(x)).sort()) {
  problems.push(`tsconfig.tsc.json checks ${rel(f)}, which reaches a .svelte and must be excluded`);
}
for (const f of [...expectedTsc].filter((x) => !actualTsc.has(x)).sort()) {
  problems.push(
    `tsconfig.tsc.json excludes ${rel(f)}, which reaches no .svelte and has silently lost TS 7`
  );
}

// 2. The svelte-check side, total: it is the safety net that means no file is ever
//    unchecked, so it must claim every source file the package owns. Narrowing it is the
//    one edit that could turn a drifted partition into a real coverage hole.
const actualSvelte = sourcesIn(svelteSet);
for (const f of [...tsFiles, ...svelteFiles].sort()) {
  if (!actualSvelte.has(f))
    problems.push(`sdk/tsconfig.json does not check ${rel(f)}; svelte-check must stay total`);
}

// 3. Ambient declarations are shared, not partitioned: both programs need
//    `__MICA_VERSION__` and the `Window` augmentation.
for (const d of dtsFiles) {
  if (!tscSet.has(d)) problems.push(`tsconfig.tsc.json: missing ambient ${rel(d)}`);
  if (!svelteSet.has(d)) problems.push(`sdk/tsconfig.json: missing ambient ${rel(d)}`);
}

if (problems.length > 0) {
  console.error('check-sdk-partition: the SDK typecheck partition has drifted.\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nThe split is derived, not declared: a `.ts` file belongs in `tsconfig.tsc.json`'s" +
      '\n`exclude` if and only if it transitively imports a `.svelte`. Fix the `exclude` list' +
      '\nto match, or change the import that moved the file.' +
      '\n\nNeither compiler reports this on its own — see the header of scripts/check-sdk-partition.js.'
  );
  process.exit(1);
}

console.log(
  `check-sdk-partition: OK — ${expectedTsc.size} pure .ts under tsc 7; ` +
    `${reaching.length} barrels reach a .svelte and are excluded; ` +
    `svelte-check still covers all ${tsFiles.length} .ts + ${svelteFiles.length} .svelte.`
);
