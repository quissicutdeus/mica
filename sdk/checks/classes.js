// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * Does every class an app writes have a rule behind it? MICA-312.
 *
 * There is no Tailwind build behind `@mica/sdk/app-utilities.css` (AGENTS.md §5): it is a
 * flat, hand-written utility layer, so a `class="..."` token with no matching rule simply
 * renders as nothing — no build error, no lint warning. That happened three times in one PR
 * here (`pt-8`, `pt-12`, `text-title-large`) before anyone saw the spacing was off by eye.
 *
 * "Statically discoverable" is a real limitation, not a formality — this is a regex scan,
 * not a Svelte parser:
 *
 * - A string literal inside a `{expr}` or a template literal's `${}` is read as a class
 *   list, unless it sits beside a comparison (`x === 'settling'`) or in an array tested
 *   with `.includes()`, where it is a value being compared.
 * - A token glued to an interpolation (`p-${n}`), or an expression with no literal at all
 *   (`class={cls}`), is **computed**: its tokens cannot be seen, so it is returned as such
 *   rather than silently skipped. Whoever calls this decides what to do about them.
 * - `.ts` is read for one pattern only: a manifest's `tile: { bg, fg }`, which `AppIcon`
 *   interpolates straight into a `class`.
 */

import { blankComments, closeBrace, lineOf } from './source.js';

/** @typedef {{ file: string, line: number, token: string }} ClassUsage */
/** @typedef {{ file: string, line: number, expr: string }} ComputedClass */

/**
 * Every class-selector name defined across some CSS, unescaped.
 *
 * A leading `.` followed by a run of either an escaped pair (`\X`) or any char that isn't a
 * selector delimiter — stops at the first unescaped `.`, `:`, `,`, whitespace, combinator,
 * or `{`, which is exactly where a hand-written utility selector (`.hover\:opacity-100:hover`,
 * `.text-\[11px\]`) ends.
 *
 * @param {string[]} cssTexts
 * @returns {Set<string>}
 */
export function definedClasses(cssTexts) {
  /** @type {Set<string>} */
  const defined = new Set();
  const classSelectorRe = /\.((?:\\.|[^\s.{:,>+~[])+)/g;
  for (const css of cssTexts) {
    for (const match of css.matchAll(classSelectorRe)) {
      defined.add(match[1].replace(/\\(.)/g, '$1'));
    }
  }
  return defined;
}

/**
 * Class tokens a JS expression can produce, and whether part of it is computed.
 *
 * @param {string} source
 * @returns {{ tokens: string[], computed: boolean }}
 */
export function readExpression(source) {
  const expr = source.replace(/\[[^[\]]*\]\s*\.(?:includes|indexOf|some|every)\(/g, (m) =>
    ' '.repeat(m.length)
  );
  /** @type {string[]} */
  const tokens = [];
  let computed = false;
  let literals = 0;
  for (let i = 0; i < expr.length; i++) {
    const quote = expr[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = i;
    let body = '';
    for (i++; i < expr.length && expr[i] !== quote; i++) {
      if (expr[i] === '\\') {
        body += expr[++i] ?? '';
      } else if (quote === '`' && expr[i] === '$' && expr[i + 1] === '{') {
        const end = closeBrace(expr, i + 1);
        const inner = readExpression(expr.slice(i + 2, end === -1 ? expr.length : end));
        tokens.push(...inner.tokens);
        if (inner.computed) computed = true;
        body += '\0';
        i = end === -1 ? expr.length : end;
      } else body += expr[i];
    }
    literals++;
    const before = expr.slice(0, start).trimEnd();
    const after = expr.slice(i + 1).trimStart();
    if (/[=!]=$/.test(before) || /^[=!]==?/.test(after)) continue;
    for (const token of body.split(/\s+/).filter(Boolean)) {
      if (token === '\0') continue;
      if (token.includes('\0')) computed = true;
      else tokens.push(token);
    }
  }
  if (literals === 0) computed = true;
  return { tokens, computed };
}

/**
 * Class tokens and computed expressions from one `.svelte` source. Blank comments first
 * (`blankComments`) — this does not, so a fixture can be fed to it as written.
 *
 * @param {string} source
 * @param {string} rel the name to report the file by
 * @returns {{ usages: ClassUsage[], computed: ComputedClass[] }}
 */
export function scanClasses(source, rel) {
  /** @type {ClassUsage[]} */
  const usages = [];
  /** @type {ComputedClass[]} */
  const computed = [];
  /** @param {number} index @param {string} expr */
  const add = (index, expr) => {
    const line = lineOf(source, index);
    const read = readExpression(expr);
    for (const token of read.tokens) usages.push({ file: rel, line, token });
    if (read.computed) computed.push({ file: rel, line, expr: expr.trim().slice(0, 70) });
  };

  // `class="..."`: static text plus any number of `{expr}` spans.
  for (const match of source.matchAll(/\bclass="((?:[^"\\]|\\.)*)"/g)) {
    const text = match[1];
    const base = (match.index ?? 0) + match[0].indexOf('"') + 1;
    let plain = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') {
        plain += text[i];
        continue;
      }
      const end = closeBrace(text, i);
      if (end === -1) break;
      add(base + i, text.slice(i + 1, end));
      plain += ' ';
      i = end;
    }
    for (const token of plain.split(/\s+/).filter(Boolean)) {
      usages.push({ file: rel, line: lineOf(source, match.index ?? 0), token });
    }
  }

  // `class={expr}`: the whole attribute is an expression (a template literal included).
  for (const match of source.matchAll(/\bclass=\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = closeBrace(source, open);
    if (end !== -1) add(open, source.slice(open + 1, end));
  }

  // `class:token` / `class:token={cond}` — Svelte's boolean class directive.
  for (const match of source.matchAll(/\bclass:([a-zA-Z][\w-]*)/g)) {
    usages.push({ file: rel, line: lineOf(source, match.index ?? 0), token: match[1] });
  }

  return { usages, computed };
}

/**
 * `scanClasses` over a component as it sits on disk: comments blanked first, so a class
 * named in a doc comment is not read as markup.
 *
 * @param {string} source
 * @param {string} rel
 * @returns {{ usages: ClassUsage[], computed: ComputedClass[] }}
 */
export function componentClasses(source, rel) {
  return scanClasses(blankComments(source), rel);
}

/**
 * `tile: { bg: 'bg-x', fg: 'text-y' }` in a manifest, as the two classes it names.
 *
 * Narrow and literal on purpose: only plain single-quoted string literals inside the object
 * are read, and anything computed is skipped rather than guessed at.
 *
 * @param {string} source
 * @returns {{ bg?: string, fg?: string, index: number } | null}
 */
export function readTile(source) {
  const match = /\btile:\s*\{([^}]*)\}/.exec(source);
  if (!match) return null;
  return {
    bg: /\bbg:\s*'([^']*)'/.exec(match[1])?.[1],
    fg: /\bfg:\s*'([^']*)'/.exec(match[1])?.[1],
    index: match.index
  };
}

/**
 * The class tokens a manifest's `tile` names, as usages at the line the tile opens on.
 *
 * @param {string} source
 * @param {string} rel
 * @returns {ClassUsage[]}
 */
export function tileClasses(source, rel) {
  const tile = readTile(source);
  if (!tile) return [];
  const line = lineOf(source, tile.index);
  return [tile.bg, tile.fg]
    .filter(/** @returns {t is string} */ (t) => !!t)
    .map((token) => ({ file: rel, line, token }));
}
