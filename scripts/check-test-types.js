// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Typecheck the test files, against a baseline that cannot go stale (MICA-320).
 *
 * `server/tsconfig.json` and `client/tsconfig.json` exclude `__tests__/`, so for a long
 * time no compiler read a test. `<target>/tsconfig.tests.json` does, under the same strict
 * TS 7 rules as the target. The tests were not clean when this landed, so the files that
 * fail today are listed in `scripts/test-types-baseline.txt` and judged against it:
 *
 *   - a test file NOT in the baseline that has an error      -> fail (a new break)
 *   - a test file IN the baseline that now has none          -> fail (remove it from the list)
 *   - a baseline entry naming a file that no longer exists   -> fail (remove it)
 *
 * so the list only ever shrinks, and a fixed file cannot quietly start regressing again.
 *
 * Failing to run is a failure. `tsc` exiting non-zero with no diagnostic located in a test
 * file (a missing config, a crash, an unparseable line) would otherwise look like "no test
 * errors"; it is reported and fails. Only diagnostics inside `<target>/__tests__/` count --
 * a test reaches into `web/` and `sdk/`, which are checked by their own compilers, and
 * their errors under a server's lib are noise this gate must not own.
 *
 *   node scripts/check-test-types.js            check
 *   node scripts/check-test-types.js --list     print the failing test files, for a baseline
 */

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Where the `<target>/tsconfig.tests.json` configs and the test files live. The override is a
// seam for the test, which points it at a scratch tree so the gate can be proved against a
// baseline of any size without depending on which real tests happen to fail today.
const ROOT = process.env.MICA_TEST_TYPES_ROOT ? resolve(process.env.MICA_TEST_TYPES_ROOT) : TOOLS;
// The override exists for the test, which proves both directions against a doctored copy.
const BASELINE = process.env.MICA_TEST_TYPES_BASELINE
  ? resolve(process.env.MICA_TEST_TYPES_BASELINE)
  : resolve(ROOT, 'scripts/test-types-baseline.txt');
const TARGETS = ['server', 'client'];

// `path(line,col): error TS1234: message`, relative to the cwd tsc ran in.
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// A diagnostic with no location: a config or option problem.
const GLOBAL_DIAGNOSTIC = /^error (TS\d+): (.*)$/;

/** Parse the baseline text: one repo-relative path a line, `#` comments and blanks ignored. */
export function parseBaseline(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * Group tsc output by file. Returns `{ byFile: Map<path, string[]>, unlocated: string[] }`;
 * `unlocated` holds diagnostics with no file, which are never baselined.
 */
export function parseTscOutput(output) {
  const byFile = new Map();
  const unlocated = [];
  for (const line of output.split('\n')) {
    const m = DIAGNOSTIC.exec(line);
    if (m) {
      const [, file, row, col, code, msg] = m;
      const list = byFile.get(file) ?? [];
      list.push(`${row}:${col} ${code} ${msg}`);
      byFile.set(file, list);
      continue;
    }
    if (GLOBAL_DIAGNOSTIC.test(line)) unlocated.push(line);
  }
  return { byFile, unlocated };
}

/**
 * Judge failing test files against the baseline. Pure, so the test drives it directly.
 *
 * @param {Set<string>} failing  test files with at least one error
 * @param {string[]} baseline    the listed files
 * @param {(path: string) => boolean} exists
 * @returns {string[]} one human line per problem; empty means pass
 */
export function judge(failing, baseline, exists) {
  const listed = new Set(baseline);
  const problems = [];
  for (const file of [...failing].sort()) {
    if (!listed.has(file)) problems.push(`NEW  ${file} fails typecheck and is not in the baseline`);
  }
  for (const file of [...listed].sort()) {
    if (!exists(file))
      problems.push(`GONE ${file} is in the baseline but does not exist; remove it`);
    else if (!failing.has(file))
      problems.push(`FIXED ${file} now typechecks; remove it from the baseline`);
  }
  const seen = new Set();
  for (const file of baseline) {
    if (seen.has(file)) problems.push(`DUP  ${file} is listed twice`);
    seen.add(file);
  }
  return problems;
}

function runTarget(target) {
  const tsc = resolve(TOOLS, 'node_modules/.bin/tsc');
  if (!existsSync(tsc)) return { fatal: `${tsc} is missing; run pnpm install` };
  const config = `${target}/tsconfig.tests.json`;
  const r = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', config], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) return { fatal: `could not run tsc for ${config}: ${r.error.message}` };
  const { byFile, unlocated } = parseTscOutput(`${r.stdout}\n${r.stderr}`);
  const failing = [...byFile.keys()].filter((f) => f.startsWith(`${target}/__tests__/`));
  if (unlocated.length > 0)
    return { fatal: `${config} reported errors with no file:\n  ${unlocated.join('\n  ')}` };
  // Non-zero with nothing parseable at all means tsc did not get to judge anything.
  if (r.status !== 0 && byFile.size === 0)
    return { fatal: `tsc exited ${r.status} for ${config} with no diagnostics:\n${r.stderr}` };
  if (r.status === 0 && byFile.size > 0)
    return { fatal: `tsc exited 0 for ${config} yet printed diagnostics` };
  return { failing, byFile };
}

function main() {
  const list = process.argv.includes('--list');
  const failing = new Set();
  const detail = new Map();
  for (const target of TARGETS) {
    const result = runTarget(target);
    if (result.fatal) {
      console.error(`check-test-types: ${result.fatal}`);
      process.exit(2);
    }
    for (const f of result.failing) {
      failing.add(f);
      detail.set(f, result.byFile.get(f));
    }
  }
  if (list) {
    for (const f of [...failing].sort()) console.log(f);
    return;
  }
  if (!existsSync(BASELINE)) {
    console.error(`check-test-types: ${BASELINE} is missing`);
    process.exit(2);
  }
  const baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
  const problems = judge(failing, baseline, (p) => existsSync(resolve(ROOT, p)));
  if (problems.length === 0) {
    console.log(
      `check-test-types: ${failing.size} baselined test file(s) still fail; no new failures.`
    );
    return;
  }
  console.error('check-test-types: the test typecheck baseline is out of date:');
  for (const p of problems) {
    console.error(`  ${p}`);
    const file = p.split(/\s+/)[1];
    for (const d of (detail.get(file) ?? []).slice(0, 3)) console.error(`      ${d}`);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
