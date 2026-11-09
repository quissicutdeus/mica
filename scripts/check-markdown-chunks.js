// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { sdkImportNames } from '../sdk/lib/permissionScan.ts';
import { addOnIds } from '../web/scripts/addon-ids.js';

/**
 * `marked` and DOMPurify ship only where markdown renders (MICA-449).
 *
 * Both reach a bundle through one SDK export, `renderMarkdown`, and both used to reach
 * every bundle: the shell's modulepreloaded `vendor` chunk evaluated them at every boot, and
 * three add-ons that never render markdown carried them too. What a bundle contains is a
 * property of the emitted files rather than of the config meant to produce them, so this
 * reads the files, at the end of `build:nocheck` for the reason `check-license-banner.js`
 * gives: a unit test reading `dist/` would run before the build and find nothing.
 *
 * Three rules, judged against the build:
 *
 * - **No startup chunk holds either library.** Startup is the entry script `index.html`
 *   loads, every chunk it modulepreloads, and every chunk those import statically — the
 *   last so a static edge Vite did not preload is still counted.
 * - **An add-on that does not render markdown holds neither.**
 * - **An add-on that renders markdown holds both.** The positive twin: the libraries are
 *   recognised by a signature, and a signature that stops matching after an upgrade would
 *   otherwise pass every bundle by finding nothing anywhere.
 *
 * "Renders markdown" is derived, never listed: an add-on whose own source imports
 * `renderMarkdown` from `@mica/sdk`, read with the same `sdkImportNames` the add-on build's
 * permission scan uses. Nothing here names Notes, so a second app that starts rendering
 * markdown is held to the positive rule without an edit.
 *
 * Absence of output is a failure, never a pass: no build, no `index.html`, no entry script,
 * a discovered add-on with no bundle, or no add-on rendering markdown at all — the last
 * because then nothing proves the signatures still match. If markdown has left the phone,
 * drop both packages and this check with them.
 *
 *   node scripts/check-markdown-chunks.js [dist] [apps]
 *     dist  the web build, default dist/web
 *     apps  the app sources, default web/src/apps
 */

/**
 * Plain `marked` is no signature: app prose says it. Each of these is an identifier the
 * library's own API exposes, so it survives minification.
 */
const LIBRARIES = [
  { name: 'marked', signature: 'walkTokens' },
  { name: 'DOMPurify', signature: 'uponSanitizeElement' }
];
const RENDERER = 'renderMarkdown';

// Relative to the working directory, as `check-no-dev-addon.js` reads `dist/`.
const dist = resolve(process.argv[2] ?? join('dist', 'web'));
const apps = resolve(process.argv[3] ?? join('web', 'src', 'apps'));
const shown = (path) => relative(process.cwd(), path) || '.';

const fail = (message) => {
  console.error(`check-markdown-chunks: ${message}`);
  process.exit(1);
};

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

if (!isDir(dist)) {
  fail(`${shown(dist)} does not exist. This runs after the web build; no build is not a pass.`);
}
const indexHtml = join(dist, 'index.html');
if (!existsSync(indexHtml)) {
  fail(`${shown(dist)} has no index.html, so it is not the web build the game loads.`);
}
if (!isDir(apps)) {
  fail(`${shown(apps)} does not exist, so which add-ons render markdown cannot be derived.`);
}

const librariesIn = (file) => {
  const text = readFileSync(file, 'utf8');
  return LIBRARIES.filter(({ signature }) => text.includes(signature)).map(({ name }) => name);
};

// ---------------------------------------------------------------- startup chunks

const html = readFileSync(indexHtml, 'utf8');
/** One tag's attribute, in whatever order Vite wrote them. */
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const entries = [...html.matchAll(/<script\b[^>]*>/g)]
  .map(([tag]) => tag)
  .filter((tag) => attr(tag, 'type') === 'module' && attr(tag, 'src'))
  .map((tag) => attr(tag, 'src'));
const preloads = [...html.matchAll(/<link\b[^>]*>/g)]
  .map(([tag]) => tag)
  .filter((tag) => attr(tag, 'rel') === 'modulepreload' && attr(tag, 'href'))
  .map((tag) => attr(tag, 'href'));

if (entries.length === 0) {
  fail(`${shown(indexHtml)} loads no module script, so there is no startup to check.`);
}
const loaded = [...entries, ...preloads].map((href) => resolve(dist, href));

/** `from"./x.js"` and a bare `import"./x.js"`; never `import("./x.js")`, which is lazy. */
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g;
const startup = new Set();
const queue = [...loaded];
while (queue.length > 0) {
  const file = queue.shift();
  if (startup.has(file)) continue;
  if (!existsSync(file)) fail(`${shown(file)} is loaded at startup but is not in the build.`);
  startup.add(file);
  for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
    queue.push(resolve(dirname(file), match[1]));
  }
}

const problems = [];
for (const file of startup) {
  const found = librariesIn(file);
  if (found.length > 0) problems.push(`  ${shown(file)} (startup) holds ${found.join(' and ')}`);
}

// ---------------------------------------------------------------- add-on bundles

const sourcesOf = (dir) => {
  let out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sourcesOf(full));
    else if (/\.(ts|js|svelte)$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) out.push(full);
  }
  return out;
};

const rendersMarkdown = (id) =>
  sourcesOf(join(apps, id)).some((file) =>
    sdkImportNames(readFileSync(file, 'utf8')).includes(RENDERER)
  );

const ids = addOnIds(apps);
if (ids.length === 0) fail(`${shown(apps)} has no add-on, so there is nothing to compare against.`);

const renderers = [];
const others = [];
for (const id of ids) {
  const bundle = join(dist, 'addons', `${id}.js`);
  if (!existsSync(bundle)) {
    fail(`${id} is an add-on in ${shown(apps)} but ${shown(bundle)} was not built.`);
  }
  const found = librariesIn(bundle);
  if (rendersMarkdown(id)) {
    renderers.push(id);
    const missing = LIBRARIES.map(({ name }) => name).filter((name) => !found.includes(name));
    if (missing.length > 0) {
      problems.push(
        `  ${shown(bundle)} renders markdown but no ${missing.join(' or ')} signature matched` +
          ' — the signature has rotted, or the library is not where it renders'
      );
    }
  } else {
    others.push(id);
    if (found.length > 0) {
      problems.push(`  ${shown(bundle)} never calls ${RENDERER} but holds ${found.join(' and ')}`);
    }
  }
}

if (renderers.length === 0) {
  fail(
    `no add-on in ${shown(apps)} imports ${RENDERER}, so nothing proves the signatures still ` +
      'match and every rule above passes by finding nothing. If markdown has left the phone, ' +
      'drop marked, dompurify and this check together.'
  );
}

if (problems.length > 0) {
  fail(
    `marked and DOMPurify belong only in what renders markdown:\n${problems.join('\n')}\n\n` +
      'A startup chunk holding them means in-process code calls renderMarkdown, or the ' +
      '`markdown` manualChunks group in web/vite.config.ts stopped matching. An add-on that ' +
      'holds them without calling it usually dynamic-imports @mica/sdk: an inlined bundle ' +
      'keeps every export of a namespace it materialises, renderMarkdown included.'
  );
}

console.log(
  `check-markdown-chunks: ${startup.size} startup chunks hold neither library; ` +
    `${renderers.join(', ')} render markdown and hold both; ` +
    `${others.length} other add-ons hold neither.`
);
