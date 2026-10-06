// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * Text helpers the source checks share. MICA-312.
 *
 * Everything under `sdk/checks/` is plain JavaScript on purpose, and is the one place in
 * this package that is: an add-on author runs these through `pnpm check` with Node, from
 * `node_modules/@mica/sdk/`, and Node refuses to strip types from a file under
 * `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). JSDoc carries the types,
 * and `tsconfig.json` checks them like any other file here.
 *
 * Nothing in this directory knows where it is: no repo-relative path, no `web/`, no
 * grandfather list. Policy that is this repo's own stays in its tests, which call these.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The 1-based line `index` falls on.
 *
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
export function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Removes any `{...}`/`${...}` span, leaving only the statically-known text around it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInterpolations(text) {
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Index of the `}` closing the `{` at `open`, skipping string literals; -1 if unbalanced.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
export function closeBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * A match replaced by as many newlines as it held, so line numbers survive a blanking.
 *
 * @param {string} match
 * @returns {string}
 */
const blank = (match) => '\n'.repeat((match.match(/\n/g) ?? []).length);

/**
 * Strips HTML/Svelte and JS block comments, keeping newlines so line numbers hold.
 *
 * @param {string} text
 * @returns {string}
 */
export function blankComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/**
 * Markup only — `<script>` and `<style>` stripped, comments blanked, line numbers preserved.
 *
 * @param {string} source
 * @returns {string}
 */
export function markupOf(source) {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * The CSS of every `<style>` block in a component, each with the line its body starts on.
 *
 * @param {string} source
 * @returns {{ css: string, line: number }[]}
 */
export function styleBlocks(source) {
  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
    css: m[1],
    line: lineOf(source, (m.index ?? 0) + m[0].indexOf('>') + 1)
  }));
}

/**
 * Every file under `dir` with one of `extensions`, in a stable order.
 *
 * `skip` names directories never descended into — `node_modules` always, since a walk that
 * reaches one reads somebody else's code and reports it as yours.
 *
 * @param {string} dir
 * @param {string[]} extensions
 * @param {string[]} [skip]
 * @returns {string[]}
 */
export function listFiles(dir, extensions, skip = ['node_modules']) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) out.push(...listFiles(full, extensions, skip));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}
