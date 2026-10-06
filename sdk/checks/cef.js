// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * The parts of the Chromium 103 floor stylelint cannot see. MICA-312.
 *
 * FiveM's release CEF is Chromium 103 (AGENTS.md §6). The shared stylelint config
 * (`stylelint.config.js` beside this file) holds the floor for CSS a parser reads. Three
 * things fall outside it, and are text checks here:
 *
 * - **An opacity modifier on a themed role** (`bg-surface/50`). A role is written at run
 *   time from the player's seed, so no stylesheet can hold a correct alpha for it, and
 *   `app-utilities.css` defines no such class: it renders as nothing. Use the
 *   pre-composited state-layer tokens (`hover:bg-surface-container-hover`).
 * - **`color-mix()` and relative colour syntax** (Chromium 111). The browser-support data
 *   stylelint's plugin reads has no entry for `color-mix()`, so it passes it — measured on
 *   stylelint-no-unsupported-browser-features 8.1.1, which flags `:has()`, `dvh` and
 *   `rgb(from …)` and not `color-mix()`.
 * - **A colour function in an inline `style=`**. PostCSS lowers `oklab()`/`oklch()` in a
 *   stylesheet or a `<style>` block, but a markup attribute never reaches it, so there the
 *   unlowered form is past the floor too.
 *
 * None of this proves anything renders in game; that takes FiveM's CEF itself.
 */

import { blankComments, lineOf, stripInterpolations } from './source.js';

/**
 * Utilities that take a color. The prefix list is what separates an opacity modifier from a
 * fraction: `bg-gray-800/50` is a color at 50%, `h-2/3` is a height.
 */
export const COLOR_PROPS =
  'bg|text|border|ring|shadow|from|via|to|divide|outline|decoration|placeholder|accent|fill|stroke|caret';

/**
 * `bg-gray-800/50`, `hover:bg-white/10`, `shadow-blue-600/30` — any color utility with an
 * opacity modifier.
 *
 * @returns {RegExp}
 */
export function opacityModifierPattern() {
  return new RegExp(
    String.raw`\b(?:[a-z-]+:)*(?:${COLOR_PROPS})-[a-zA-Z0-9\[\]#().,%_-]+\/\d{1,3}\b`,
    'g'
  );
}

/**
 * An opacity modifier on one of `roles` specifically. Longest name first, so
 * `surface-container/8` is read as that role and not as `surface` with a tail.
 *
 * @param {readonly string[]} roles
 * @returns {RegExp}
 */
export function roleOpacityPattern(roles) {
  const names = [...roles].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(String.raw`\b(?:[a-z-]+:)*(?:${COLOR_PROPS})-(?:${names})\/\d{1,3}\b`, 'g');
}

/**
 * The themed color roles a stylesheet declares: every `--color-<name>` custom property in
 * it. Read off the SDK's own `app.css`, so a tool outside this repo needs no copy of the
 * role list — `sdk/cef.test.ts` asserts the answer covers `ROLE_NAMES`.
 *
 * @param {string} css
 * @returns {string[]}
 */
export function colorTokensDeclared(css) {
  return [...new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]))];
}

/**
 * Every `--name` declared across some CSS.
 *
 * @param {string[]} cssTexts
 * @returns {Set<string>}
 */
export function declaredProperties(cssTexts) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const css of cssTexts) {
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Each role-token opacity modifier in a source, with its line. Comments are blanked first,
 * so prose naming the banned form does not count.
 *
 * @param {string} source
 * @param {readonly string[]} roles
 * @returns {{ line: number, hit: string }[]}
 */
export function roleOpacityHits(source, roles) {
  const text = blankComments(source);
  return [...text.matchAll(roleOpacityPattern(roles))].map((m) => ({
    line: lineOf(text, m.index ?? 0),
    hit: m[0]
  }));
}

/** Colour syntax newer than Chromium 103, with no fallback once it is past PostCSS. */
export const POST_103_COLOR =
  /\b(?:color-mix|oklab|oklch)\(|\b(?:rgba?|hsla?|hwb|lab|lch)\(\s*from\b/g;

/**
 * Colour syntax newer than Chromium 103 that PostCSS does **not** lower either, so it is
 * past the floor even in a stylesheet. `oklab()`/`oklch()` are absent: the template's and the
 * phone's `postcss.config.js` lower both.
 */
export const POST_103_COLOR_IN_CSS = /\bcolor-mix\(|\b(?:rgba?|hsla?|hwb|lab|lch)\(\s*from\b/g;

/**
 * The statically-known text of every `style="..."` attribute, with the line it is on.
 *
 * @param {string} source
 * @returns {{ style: string, line: number }[]}
 */
export function inlineStyles(source) {
  return [...source.matchAll(/\bstyle="([^"]*)"/g)].map((m) => ({
    style: stripInterpolations(m[1]),
    line: lineOf(source, m.index ?? 0)
  }));
}

/**
 * Each post-103 colour function in an inline `style=`.
 *
 * @param {string} source
 * @returns {{ line: number, hit: string }[]}
 */
export function inlineStyleColorHits(source) {
  return inlineStyles(blankComments(source)).flatMap(({ style, line }) =>
    [...style.matchAll(POST_103_COLOR)].map((m) => ({ line, hit: m[0] }))
  );
}

/**
 * Each colour function past the floor that PostCSS will not lower, in CSS text (a `.css`
 * file, or a `<style>` block's body). `line` is relative to the start of `css`; add the
 * block's own starting line, less one, to place it in a component.
 *
 * @param {string} css
 * @returns {{ line: number, hit: string }[]}
 */
export function cssColorHits(css) {
  const text = blankComments(css);
  return [...text.matchAll(POST_103_COLOR_IN_CSS)].map((m) => ({
    line: lineOf(text, m.index ?? 0),
    hit: m[0]
  }));
}
