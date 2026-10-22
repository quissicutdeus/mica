// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { globSync, readFileSync } from 'node:fs';

/**
 * Catalog keys that nothing reads (MICA-423). A key nobody looks up is a string a translator
 * is still asked to translate and an owner still ships, so `generate-locales.js --check`
 * (the `locales` gate) fails on one.
 *
 * "Read" means the full key, `<namespace>.<key>`, appears as a whole token in non-test source
 * under `SOURCE_DIRS`, comments stripped. One limit, stated so nobody reads more into a pass
 * than it says: a key built at run time is invisible to a text search, which is why
 * `FAMILIES` exists.
 *
 * Fails loudly rather than passing on nothing: no source files, or a catalog set with no
 * keys, is an error, and so is a `FAMILIES` entry whose dynamic call site is gone -- that
 * family would otherwise go on excusing keys nothing builds any more.
 */

/** Where a key can be read from. Tests and e2e specs reading a key do not make it used. */
export const SOURCE_DIRS = ['web/src', 'sdk', 'shared', 'server', 'client'];

const SKIP = /node_modules|\/dist\/|\.test\.|\.spec\.|__tests__|\/e2e\/|\.d\.ts$|\/locales\//;

/**
 * Plural categories. `plural('<ns>.<base>', n)` reads `<ns>.<base>.one`, `.other` and the
 * rest by `Intl.PluralRules`, so the entry is read when `<ns>.<base>` is named literally.
 */
const PLURAL_SUFFIX = /\.(?:zero|one|two|few|many|other)$/;

/**
 * Key families built at run time, so a text search cannot see their members. Each is allowed
 * explicitly and narrowly: `match` is the exact set of keys, and `site` is the template
 * literal that builds them, which must still be in source or the family is itself an error.
 */
export const FAMILIES = [
  {
    match: /^settings\.yourData\.cat\./,
    site: 'settings.yourData.cat.${',
    why: 'one label per export category, keyed by the category id the server sends'
  },
  {
    match: /^store\.permission\./,
    site: 'store.permission.${',
    why: 'one line per manifest permission, keyed by its name'
  },
  {
    match: /^store\.needs\./,
    site: 'store.needs.${',
    why: 'one line per thing an add-on lacks, keyed by the requirement'
  },
  {
    match: /^casino\.dozen\.[123]$/,
    site: 'casino.dozen.${',
    why: 'the three roulette dozens, keyed by number'
  },
  {
    match: /^casino\.(?:red|black|odd|even|low|high)$/,
    site: 'casino.${',
    why: 'the outside-bet cells of the roulette table, keyed by bet kind'
  },
  {
    match: /^settings\.frame\.(?:classic|notch|punch)$/,
    site: 'settings.frame.${',
    why: 'one label per frame style in the frame picker'
  },
  {
    match: /^settings\.frame\.color\.[a-z]+$/,
    site: 'settings.frame.color.${',
    why: 'one label per frame colour in the frame picker'
  }
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Block, line and HTML comments removed, so a key that only a comment names is not "read".
 * Deliberately blunt: a `//` is a comment only after whitespace or at a line start (so a URL
 * survives), and a stray `/*` inside a string can swallow code up to the next close. That
 * errs towards reporting a key unused -- a loud failure -- never towards hiding one.
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** The text of every source file a key can be read from, joined. */
function readSource(root) {
  const files = SOURCE_DIRS.flatMap((dir) =>
    globSync(`${dir}/**/*.{ts,js,svelte}`, { cwd: root })
  ).filter((file) => !SKIP.test(file));
  if (files.length === 0) {
    throw new Error(`no source files found under ${SOURCE_DIRS.join(', ')}; did they move?`);
  }
  return files.map((file) => stripComments(readFileSync(`${root}/${file}`, 'utf8'))).join('\n');
}

/**
 * The full keys (`<namespace>.<key>`) of the `en` catalogs that nothing reads, sorted, with
 * the catalog file each lives in. `catalogs` is what `discoverCatalogs` returns. Throws on
 * an empty tree, empty catalogs, or a `FAMILIES` entry whose `site` is no longer in source.
 */
export function findUnusedKeys(root, catalogs) {
  const source = readSource(root);

  const keys = [];
  for (const [namespace, langs] of catalogs) {
    const en = langs.get('en');
    for (const key of Object.keys(en.entries))
      keys.push({ full: `${namespace}.${key}`, path: en.path });
  }
  if (keys.length === 0) throw new Error('the catalogs hold no keys at all; did they move?');

  const stale = FAMILIES.filter((family) => !source.includes(family.site));
  if (stale.length > 0) {
    throw new Error(
      'a dynamic key family in scripts/lib/localeUsage.js no longer has its call site in ' +
        `source (${stale.map((f) => f.site).join(', ')}). Remove the family, or fix its site.`
    );
  }

  const read = (full) => new RegExp(`(?<![\\w.])${escape(full)}(?![\\w])`).test(source);
  return keys
    .filter(({ full }) => {
      if (read(full)) return false;
      if (PLURAL_SUFFIX.test(full) && read(full.replace(PLURAL_SUFFIX, ''))) return false;
      return !FAMILIES.some((family) => family.match.test(full));
    })
    .sort((a, b) => a.full.localeCompare(b.full));
}
