// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-check

/**
 * `Screen`'s sizing contract, checked statically. MICA-312, from MICA-89.
 *
 * `Screen`'s content box hands an app a definite height (see `ui/Screen.svelte`, whose
 * comment spells out the contract, and AGENTS.md §5). Inside it an app fills with
 * `min-h-0 flex-1`, and two other ways of filling look right and are not:
 *
 * - **`h-full`** on a direct child. A percentage against a box that has already resolved,
 *   so it gives no bound to anything under it.
 * - **`flex-1` without `min-h-0`** on a child wrapping a scroller. A flex item's default
 *   `min-height: auto` resolves to its content's minimum, so it claims the leftover space
 *   and then refuses to give any back once the content is the larger of the two.
 *
 * Both fail silently and only under enough content, which is what makes them worth a static
 * check: MICA-89 was a composer walking ~82px down the screen per message sent, and another
 * sitting 4000px below the visible screen. A box declaring `overflow-y-auto` scrolls itself
 * and is exempt.
 *
 * Only the **root** of a direct child is checked — the boundary where the contract applies.
 * A component child hands the contract to whatever it opens with, followed through relative
 * `.svelte` imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { lineOf, markupOf, stripInterpolations } from './source.js';

/**
 * A tag as it appears in Svelte markup, with its attribute text and where it starts.
 *
 * @typedef {{ name: string, kind: 'open' | 'close' | 'self', attrs: string, index: number }} MarkupTag
 */

/**
 * One `Screen` child root breaking the contract. `file`/`line` locate the root itself;
 * `via` is set when that root was reached through a component tag, naming the tag and the
 * file the `<Screen>` is in.
 *
 * @typedef {{ file: string, line: number, tokens: string[], via?: { tag: string, file: string } }} ScreenViolation
 */

/**
 * Reads a file, or answers `undefined` when there is none. Injected so a caller can run the
 * checks over text that is not on disk.
 *
 * @typedef {(file: string) => string | undefined} ReadFile
 */

/** @type {ReadFile} */
export const readFromDisk = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;

/**
 * `read`, but a file that is not there is an error rather than an empty answer. A check that
 * skipped a component it could not find would match less while still reporting a pass.
 *
 * @param {ReadFile} read
 * @param {string} file
 * @param {string} [from] the file whose import named it
 * @returns {string}
 */
function readOrThrow(read, file, from) {
  const source = read(file);
  if (source === undefined) {
    throw new Error(
      from
        ? `${from} imports ${file}, which does not exist, so the Screen contract cannot be checked through it`
        : `${file} does not exist`
    );
  }
  return source;
}

/** HTML elements that close themselves whether or not the author wrote the slash. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
]);

/**
 * Every tag in a chunk of Svelte markup, in source order.
 *
 * A regex cannot do this: an attribute value holds `>` routinely — every arrow function in
 * an `onclick={() => …}` has one — so a scan that stops at the first `>` splits tags in half
 * and mis-reads the nesting. This walks the text instead, holding quote state and `{}` depth,
 * and only treats a `>` outside both as the end of a tag.
 *
 * @param {string} source
 * @returns {MarkupTag[]}
 */
export function scanTags(source) {
  /** @type {MarkupTag[]} */
  const tags = [];
  const nameRe = /^<(\/?)([A-Za-z][\w.:-]*)/;

  for (let i = 0; i < source.length;) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    const name = nameRe.exec(source.slice(lt, lt + 64));
    if (!name) {
      i = lt + 1;
      continue;
    }

    let end = lt + name[0].length;
    let quote = '';
    let depth = 0;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (ch === '>' && depth === 0) {
        break;
      }
    }

    const selfClosing = source[end - 1] === '/' || VOID_ELEMENTS.has(name[2]);
    tags.push({
      name: name[2],
      kind: name[1] ? 'close' : selfClosing ? 'self' : 'open',
      attrs: source.slice(lt + name[0].length, source[end - 1] === '/' ? end - 1 : end),
      index: lt
    });
    i = end + 1;
  }

  return tags;
}

/**
 * `[start, end)` of every `{#snippet …}` … `{/snippet}` region, so its tags can be skipped.
 *
 * @param {string} source
 * @returns {Array<[number, number]>}
 */
export function snippetRegions(source) {
  /** @type {Array<[number, number]>} */
  const regions = [];
  for (const open of source.matchAll(/\{#snippet\b/g)) {
    const close = source.indexOf('{/snippet}', open.index ?? 0);
    if (close !== -1) regions.push([open.index ?? 0, close + '{/snippet}'.length]);
  }
  return regions;
}

/**
 * The statically-known class tokens on a tag, with `{expr}` spans dropped.
 *
 * @param {MarkupTag} tag
 * @returns {string[]}
 */
export function classTokensOf(tag) {
  const literal = /\bclass="((?:[^"\\]|\\.)*)"/.exec(tag.attrs)?.[1];
  const template = /\bclass=\{`((?:[^`\\]|\\.)*)`\}/.exec(tag.attrs)?.[1];
  const text = literal ?? template ?? '';
  return stripInterpolations(text.replace(/\$\{/g, '{')).split(/\s+/).filter(Boolean);
}

/**
 * The elements a component opens with — its depth-0 tags, `{#if}` branches included.
 *
 * @param {string} markup
 * @returns {MarkupTag[]}
 */
export function rootTags(markup) {
  const skip = snippetRegions(markup);
  /** @type {MarkupTag[]} */
  const roots = [];
  let depth = 0;
  for (const tag of scanTags(markup)) {
    if (skip.some(([from, to]) => tag.index >= from && tag.index < to)) continue;
    if (tag.kind === 'close') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) roots.push(tag);
    if (tag.kind === 'open') depth++;
  }
  return roots;
}

/**
 * `import Foo from './components/Foo.svelte'` → `{ Foo: '/abs/path/Foo.svelte' }`. Relative
 * imports only: a package's component is not the author's to fix.
 *
 * @param {string} file
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function svelteImports(file, source) {
  /** @type {Map<string, string>} */
  const imports = new Map();
  for (const match of source.matchAll(/\bimport\s+(\w+)\s+from\s+'([^']+\.svelte)'/g)) {
    if (!match[2].startsWith('.')) continue;
    imports.set(match[1], path.resolve(path.dirname(file), match[2]));
  }
  return imports;
}

/**
 * Calls `visit` with each depth-0 tag inside every `<Screen>` in `tags`, outside snippets.
 *
 * @param {MarkupTag[]} tags
 * @param {Array<[number, number]>} skip
 * @param {(tag: MarkupTag) => void} visit
 */
function eachScreenChild(tags, skip, visit) {
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].name !== 'Screen' || tags[i].kind !== 'open') continue;

    // Walk this `<Screen>`'s span, collecting the tags that sit at its own depth.
    let depth = 0;
    for (let j = i + 1; j < tags.length; j++) {
      const tag = tags[j];
      if (tag.kind === 'close') {
        if (depth === 0) break;
        depth--;
        continue;
      }
      const inSnippet = skip.some(([from, to]) => tag.index >= from && tag.index < to);
      if (depth === 0 && !inSnippet) visit(tag);
      if (tag.kind === 'open') depth++;
    }
  }
}

/**
 * Every root of a `Screen` child that fills with `h-full`.
 *
 * @param {string[]} files absolute paths of the `.svelte` files to read
 * @param {ReadFile} [read]
 * @returns {ScreenViolation[]}
 */
export function screenHeightViolations(files, read = readFromDisk) {
  /** @type {ScreenViolation[]} */
  const offenders = [];

  /** @typedef {{ tag: MarkupTag, file: string, markup: string }} Root */

  /**
   * The root tags of `<Foo />`, each carried with the file and markup it was read from so
   * it can be reported at its own line. Followed through a component whose own root is
   * another component, since that one inherits the contract in turn.
   *
   * @param {string} file
   * @param {string} from
   * @param {Set<string>} [seen]
   * @returns {Root[]}
   */
  const rootsOf = (file, from, seen = new Set()) => {
    if (seen.has(file)) return [];
    const source = readOrThrow(read, file, from);
    seen.add(file);
    const markup = markupOf(source);
    const imports = svelteImports(file, source);
    return rootTags(markup).flatMap((tag) => {
      const nested = imports.get(tag.name);
      return nested ? rootsOf(nested, file, seen) : [{ tag, file, markup }];
    });
  };

  for (const file of files) {
    const source = readOrThrow(read, file);
    const markup = markupOf(source);
    const imports = svelteImports(file, source);

    eachScreenChild(scanTags(markup), snippetRegions(markup), (tag) => {
      // A component child hands the contract to whatever *it* opens with.
      const child = imports.get(tag.name);
      const roots = child ? rootsOf(child, file) : [{ tag, file, markup }];
      for (const root of roots) {
        const tokens = classTokensOf(root.tag);
        if (!tokens.includes('h-full')) continue;
        offenders.push({
          file: root.file,
          line: lineOf(root.markup, root.tag.index),
          tokens,
          ...(child ? { via: { tag: tag.name, file } } : {})
        });
      }
    });
  }

  return offenders;
}

/**
 * Every root of a `Screen` child that fills with `flex-1`, has no `min-h-0`, and wraps a box
 * meant to scroll itself.
 *
 * Scoped to roots that actually contain a scroll region, deliberately: a `flex-1` root with
 * no scroller under it has nothing to divide up, so `min-h-0` would be noise — and a root
 * whose content genuinely exceeds the screen still overflows to `Screen`'s own scroller,
 * which is what a feed wants.
 *
 * @param {string[]} files absolute paths of the `.svelte` files to read
 * @param {ReadFile} [read]
 * @returns {ScreenViolation[]}
 */
export function screenFillViolations(files, read = readFromDisk) {
  /** @type {ScreenViolation[]} */
  const offenders = [];

  /** @param {MarkupTag} tag */
  const scrolls = (tag) =>
    classTokensOf(tag).some((t) => t === 'overflow-y-auto' || t === 'overflow-auto');

  /**
   * Every tag in a component, scroll regions inside the components *it* renders included.
   *
   * @param {string} file
   * @param {Set<string>} seen
   * @returns {boolean}
   */
  const scrollsAnywhere = (file, seen) => {
    if (seen.has(file)) return false;
    const source = read(file);
    if (source === undefined) return false;
    seen.add(file);
    const imports = svelteImports(file, source);
    return scanTags(markupOf(source)).some((tag) => {
      const nested = imports.get(tag.name);
      return scrolls(tag) || (nested !== undefined && scrollsAnywhere(nested, seen));
    });
  };

  /**
   * Does the subtree this tag opens contain a box that scrolls itself? Follows component
   * tags as well as elements: the core Messages thread keeps its scroller inside
   * `MessageThread`, one file away from the root that has to shrink for it.
   *
   * @param {MarkupTag[]} tags
   * @param {number} from
   * @param {Map<string, string>} imports
   * @returns {boolean}
   */
  const wrapsAScroller = (tags, from, imports) => {
    let depth = 0;
    for (let i = from; i < tags.length; i++) {
      const tag = tags[i];
      if (tag.kind === 'close') {
        if (--depth <= 0) break;
        continue;
      }
      if (i > from) {
        const child = imports.get(tag.name);
        if (scrolls(tag) || (child && scrollsAnywhere(child, new Set()))) return true;
      }
      if (tag.kind === 'open') depth++;
    }
    return false;
  };

  /**
   * @param {{ tag: MarkupTag, file: string, markup: string }} root
   * @param {MarkupTag[]} tags
   * @param {Map<string, string>} imports
   * @param {{ tag: string, file: string }} [via]
   */
  const flag = (root, tags, imports, via) => {
    const tokens = classTokensOf(root.tag);
    if (!tokens.includes('flex-1') || tokens.includes('min-h-0')) return;
    const at = tags.findIndex((t) => t.index === root.tag.index);
    if (at < 0 || !wrapsAScroller(tags, at, imports)) return;
    offenders.push({
      file: root.file,
      line: lineOf(root.markup, root.tag.index),
      tokens,
      ...(via ? { via } : {})
    });
  };

  for (const file of files) {
    const source = readOrThrow(read, file);
    const markup = markupOf(source);
    const imports = svelteImports(file, source);
    const tags = scanTags(markup);

    eachScreenChild(tags, snippetRegions(markup), (tag) => {
      const child = imports.get(tag.name);
      if (!child) {
        flag({ tag, file, markup }, tags, imports);
        return;
      }
      const childSource = readOrThrow(read, child, file);
      const childMarkup = markupOf(childSource);
      const childTags = scanTags(childMarkup);
      const childImports = svelteImports(child, childSource);
      for (const root of rootTags(childMarkup)) {
        flag({ tag: root, file: child, markup: childMarkup }, childTags, childImports, {
          tag: tag.name,
          file
        });
      }
    });
  }

  return offenders;
}
