// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * The source checks micaOS holds its own apps to, run over an add-on's tree. MICA-312.
 *
 * What `checks/cli.js` runs before stylelint, and what `pnpm check` in the add-on template
 * runs through it. Every check here is the one this repo's own suites call — the class
 * scan, the `Screen` sizing rules, the role-token opacity ban — with none of this repo's
 * grandfather lists, ratchets or paths: an add-on starts clean and is held to zero.
 *
 * Two differences from the in-repo scan, both because an add-on is not this repo:
 *
 * - **A class is defined if the SDK's stylesheets define it, or the add-on's own CSS does** —
 *   a `.css` file anywhere under the scanned directories, or the component's own `<style>`
 *   block. Svelte scopes a `<style>` block to its component, so a class from one component's
 *   block does not count for another.
 * - **Computed class expressions are listed, not failed.** Their tokens cannot be read, so
 *   the check says how many it could not see rather than passing over them in silence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentClasses, definedClasses, tileClasses } from './classes.js';
import { colorTokensDeclared, cssColorHits, inlineStyleColorHits, roleOpacityHits } from './cef.js';
import { screenFillViolations, screenHeightViolations } from './screen.js';
import { blankComments, listFiles, styleBlocks } from './source.js';

/**
 * One violation, as `file:line rule message`.
 *
 * @typedef {{ file: string, line: number, rule: string, message: string }} Violation
 */

/** @typedef {import('./classes.js').ComputedClass} ComputedClass */

/**
 * The SDK stylesheets a class may resolve to, read from this package rather than from any
 * path in micaOS. Out of `@mica/sdk/app.css`'s own `@import`s: an add-on bundle inlines all
 * three.
 */
export const SDK_STYLESHEETS = ['app.css', 'app-utilities.css', 'app-reset.css'];

/**
 * A matched colour function as an author would write it: `color-mix(` reads as `color-mix()`.
 *
 * @param {string} hit
 */
const shown = (hit) => (hit.endsWith('(') ? `${hit})` : `${hit}…`);

/** The package root this file ships in, wherever it was installed. */
const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories never scanned: installs, and the two build outputs the template writes. */
const SKIP = ['node_modules', 'dist', 'dist-dev'];

/**
 * The SDK's stylesheets as text, keyed by file name. Throws when one is missing, so a
 * broken install cannot turn the class check into a scan against nothing.
 *
 * @param {string} [sdkDir]
 * @returns {Record<string, string>}
 */
export function readSdkStylesheets(sdkDir = SDK_DIR) {
  return Object.fromEntries(
    SDK_STYLESHEETS.map((name) => {
      const file = path.join(sdkDir, name);
      if (!fs.existsSync(file)) {
        throw new Error(`cannot read ${file}: is @mica/sdk installed completely?`);
      }
      return [name, fs.readFileSync(file, 'utf8')];
    })
  );
}

/**
 * Every file under `dirs` the checks read, by kind. Relative paths are resolved from `cwd`.
 *
 * @param {string[]} dirs
 * @param {string} cwd
 * @returns {{ svelte: string[], ts: string[], css: string[] }}
 */
export function collectFiles(dirs, cwd) {
  /** @type {string[]} */
  const all = [];
  for (const dir of dirs) {
    const abs = path.resolve(cwd, dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    all.push(...listFiles(abs, ['.svelte', '.ts', '.css'], SKIP));
  }
  const files = [...new Set(all)].sort();
  return {
    svelte: files.filter((f) => f.endsWith('.svelte')),
    ts: files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')),
    css: files.filter((f) => f.endsWith('.css'))
  };
}

/**
 * Runs every source check over an add-on's files.
 *
 * @param {{ svelte: string[], ts: string[], css: string[] }} files absolute paths
 * @param {{ cwd: string, sdk?: Record<string, string> }} options `sdk` is the SDK's
 *   stylesheets by name (`readSdkStylesheets()` when absent)
 * @returns {{ violations: Violation[], computed: ComputedClass[] }}
 */
export function checkAddonSources(files, { cwd, sdk = readSdkStylesheets() }) {
  /** @param {string} file */
  const rel = (file) => path.relative(cwd, file).split(path.sep).join('/');
  /** @param {string} file */
  const read = (file) => fs.readFileSync(file, 'utf8');

  const sdkClasses = definedClasses(Object.values(sdk));
  const roles = colorTokensDeclared(sdk['app.css'] ?? '');
  // Not a violation of the add-on's, and not something to pass over either: with no rules
  // or no roles to compare against, every check below would come back empty.
  if (sdkClasses.size < 100) {
    throw new Error(`read only ${sdkClasses.size} classes out of the SDK's stylesheets`);
  }
  if (roles.length < 20) {
    throw new Error(`read only ${roles.length} --color-* roles out of the SDK's app.css`);
  }

  const projectCss = files.css.map(read);
  const shared = new Set([...sdkClasses, ...definedClasses(projectCss)]);

  /** @type {Violation[]} */
  const violations = [];
  /** @type {ComputedClass[]} */
  const computed = [];

  /**
   * @param {import('./classes.js').ClassUsage[]} usages
   * @param {Set<string>} defined
   */
  const unknown = (usages, defined) => {
    for (const u of usages) {
      if (defined.has(u.token)) continue;
      violations.push({
        file: u.file,
        line: u.line,
        rule: 'mica/unknown-class',
        message:
          `"${u.token}" has no rule in @mica/sdk/app-utilities.css or in this add-on's own CSS, ` +
          'so it renders as nothing'
      });
    }
  };

  /**
   * @param {string} file
   * @param {string} source
   */
  const cefText = (file, source) => {
    for (const { line, hit } of roleOpacityHits(source, roles)) {
      violations.push({
        file: rel(file),
        line,
        rule: 'mica/role-token-opacity',
        message:
          `"${hit}" puts an opacity modifier on a themed role, which has no rule and would be ` +
          'wrong under any other seed; use a state-layer token (`hover:bg-surface-container-hover`)'
      });
    }
  };

  for (const file of files.svelte) {
    const source = read(file);
    const own = styleBlocks(source);
    const defined = own.length
      ? new Set([...shared, ...definedClasses(own.map((b) => b.css))])
      : shared;
    const found = componentClasses(source, rel(file));
    unknown(found.usages, defined);
    computed.push(...found.computed);
    cefText(file, source);

    for (const { line, hit } of inlineStyleColorHits(source)) {
      violations.push({
        file: rel(file),
        line,
        rule: 'mica/inline-style-floor',
        message: `${shown(hit)} in an inline style= is past Chromium 103, and PostCSS never sees it`
      });
    }
    for (const block of own) {
      for (const { line, hit } of cssColorHits(block.css)) {
        violations.push({
          file: rel(file),
          line: block.line + line - 1,
          rule: 'mica/css-color-floor',
          message: `${shown(hit)} is Chromium 111, past the CEF 103 floor, and PostCSS does not lower it`
        });
      }
    }
  }

  for (const file of files.ts) {
    const source = read(file);
    unknown(tileClasses(source, rel(file)), shared);
    cefText(file, source);
  }

  for (const [file, css] of files.css.map((f, i) => /** @type {const} */ ([f, projectCss[i]]))) {
    for (const { line, hit } of cssColorHits(css)) {
      violations.push({
        file: rel(file),
        line,
        rule: 'mica/css-color-floor',
        message: `${shown(hit)} is Chromium 111, past the CEF 103 floor, and PostCSS does not lower it`
      });
    }
  }

  for (const v of screenHeightViolations(files.svelte)) {
    violations.push({
      file: rel(v.file),
      line: v.line,
      rule: 'mica/screen-h-full',
      message:
        (v.via ? `<${v.via.tag}> in ${rel(v.via.file)}: ` : '') +
        'a direct child of Screen fills with h-full, which resolves against nothing; ' +
        'fill with `min-h-0 flex-1`'
    });
  }
  for (const v of screenFillViolations(files.svelte)) {
    violations.push({
      file: rel(v.file),
      line: v.line,
      rule: 'mica/screen-flex-1-without-min-h-0',
      message:
        (v.via ? `<${v.via.tag}> in ${rel(v.via.file)}: ` : '') +
        `"${v.tokens.join(' ')}" fills with flex-1 and no min-h-0 around a scroller, so it is ` +
        'sized by its content; add `min-h-0`'
    });
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { violations, computed };
}

/**
 * What stylelint hands back for one file — the fields this reads, and no more.
 *
 * @typedef {{
 *   source?: string,
 *   ignored?: boolean,
 *   _postcssResult?: { root?: { type?: string, nodes?: unknown[] } }
 * }} LintedFile
 */

/**
 * The files stylelint was given CSS in and parsed none of.
 *
 * A green stylelint run is only evidence if something was read. Point `postcss-html` at a
 * plain stylesheet and it parses the file as HTML, finds no `<style>`, and returns an empty
 * document with no warnings — a result for every file, a pass for every file, and nothing
 * checked. That is how this repo's `lint:css` read no `.css` file at all until MICA-312, and
 * a count of results cannot see it. So: any file with CSS in it (a stylesheet with more than
 * comments, a component with a `<style>` block) whose parsed root holds nothing is named,
 * and so is one stylelint ignored.
 *
 * `_postcssResult` is stylelint's own field rather than documented API; a result without it
 * is reported too, so a stylelint that stops providing it fails this loudly instead of
 * passing everything.
 *
 * @param {LintedFile[]} results
 * @param {(file: string) => string} read
 * @returns {string[]}
 */
export function unparsedStylesheets(results, read) {
  return results
    .filter((result) => {
      if (!result.source) return true;
      const text = read(result.source);
      const css = result.source.endsWith('.css')
        ? text
        : styleBlocks(text)
            .map((b) => b.css)
            .join('\n');
      if (blankComments(css).trim() === '') return false;
      if (result.ignored) return true;
      return (result._postcssResult?.root?.nodes?.length ?? 0) === 0;
    })
    .map((result) => result.source ?? '(a result with no file)');
}
