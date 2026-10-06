#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * `node node_modules/@mica/sdk/checks/cli.js [dir ...]` — the add-on template's `pnpm check`
 * half that is not `svelte-check`. MICA-312.
 *
 * Runs, over each directory given (`src` when none is):
 *
 * 1. The source checks in `addon.js`: unknown utility classes, `Screen` sizing, role-token
 *    opacity, and the colour syntax stylelint cannot see.
 * 2. stylelint, with `@mica/sdk/stylelint` (`stylelint.config.js` here), over every `.css`
 *    and `.svelte` file — `:has()`, container queries, `dvh`/`svh` and the rest of the
 *    Chromium 103 floor.
 *
 * Prints one `file:line rule message` line per violation and exits 1 if there are any.
 * Exits 2, also loudly, when it cannot run at all: no directory, no `.svelte` file in it,
 * stylelint not installed, or an SDK install it cannot read. A check that passes because it
 * looked at nothing is worse than none, since it reads as a pass.
 *
 * stylelint is resolved from the working directory — the add-on's own `devDependencies` —
 * rather than from this package, which brings no tooling with it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkAddonSources, collectFiles, unparsedStylesheets } from './addon.js';
import cefFloor from './stylelint.config.js';

const TOOLING = ['stylelint', 'stylelint-no-unsupported-browser-features', 'postcss-html'];

/** @param {string} message */
const cannotRun = (message) => {
  console.error(`mica check: cannot run — ${message}`);
  process.exit(2);
};

const cwd = process.cwd();
const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push('src');

/** @type {ReturnType<typeof collectFiles>} */
let files;
try {
  files = collectFiles(dirs, cwd);
} catch (error) {
  cannotRun(error instanceof Error ? error.message : String(error));
  throw error;
}
if (files.svelte.length === 0) {
  cannotRun(`found no .svelte file under ${dirs.join(', ')}, so there is nothing to check`);
}

/** @type {ReturnType<typeof checkAddonSources>} */
let sources;
try {
  sources = checkAddonSources(files, { cwd });
} catch (error) {
  cannotRun(error instanceof Error ? error.message : String(error));
  throw error;
}

/** @type {{ file: string, line: number, rule: string, message: string }[]} */
const violations = [...sources.violations];

/** @type {{ lint: (options: object) => Promise<any> }} */
let stylelint;
try {
  const require = createRequire(path.join(cwd, 'package.json'));
  const missing = TOOLING.filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    cannotRun(
      `${missing.join(', ')} not installed in ${cwd}. Add ${TOOLING.join(', ')} to ` +
        'devDependencies: the Chromium 103 floor is checked with them.'
    );
  }
  const loaded = await import(pathToFileURL(require.resolve('stylelint')).href);
  stylelint = loaded.default ?? loaded;
} catch (error) {
  cannotRun(`stylelint did not load: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

const styled = [...files.css, ...files.svelte];
/** @type {any} */
let linted;
try {
  linted = await stylelint.lint({ files: styled, config: cefFloor, configBasedir: cwd, cwd });
} catch (error) {
  cannotRun(`stylelint failed: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

/** @param {string} file */
const rel = (file) => path.relative(cwd, file).split(path.sep).join('/');
const results = /** @type {any[]} */ (linted.results);
if (results.length !== styled.length) {
  cannotRun(`stylelint read ${results.length} of the ${styled.length} files it was given`);
}
const unparsed = unparsedStylesheets(results, (file) => fs.readFileSync(file, 'utf8'));
if (unparsed.length > 0) {
  cannotRun(
    `stylelint parsed no CSS out of ${unparsed.map(rel).join(', ')}, so the Chromium 103 ` +
      'floor was not checked there. Is a custom syntax applied to a plain stylesheet?'
  );
}
for (const result of results) {
  for (const w of result.invalidOptionWarnings ?? []) {
    cannotRun(`stylelint config is invalid: ${w.text}`);
  }
  for (const w of [...(result.warnings ?? []), ...(result.parseErrors ?? [])]) {
    const rule = w.rule ?? 'stylelint';
    violations.push({
      file: rel(result.source),
      line: w.line ?? 0,
      rule,
      message: String(w.text).replace(` (${rule})`, '').trim()
    });
  }
}

const unread = sources.computed.length;
const scanned =
  `${files.svelte.length} .svelte, ${files.ts.length} .ts, ${files.css.length} .css ` +
  `under ${dirs.join(', ')}`;

if (unread > 0) {
  console.log(
    `mica check: ${unread} computed class expression(s) could not be read, so the classes ` +
      'they produce are unchecked. Prefer string literals in a class expression:'
  );
  for (const c of sources.computed) console.log(`  ${c.file}:${c.line} ${c.expr}`);
}

if (violations.length > 0) {
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule} ${v.message}`);
  console.error(`\nmica check: ${violations.length} violation(s) in ${scanned}.`);
  process.exit(1);
}

console.log(`mica check: OK — ${scanned}.`);
