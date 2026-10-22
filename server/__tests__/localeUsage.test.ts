// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FAMILIES, findUnusedKeys, stripComments } from '../../scripts/lib/localeUsage.js';

/**
 * The unused-key check behind the `locales` gate (MICA-423), on scratch trees. The real tree
 * is held by the gate itself; this holds the rules the gate relies on, including that it
 * refuses to pass when it could not look.
 */

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Source holding every family's template, so only the case under test can be missing one. */
const SITES = FAMILIES.map((f) => `t(\`${f.site}id}\`);`).join('\n');

const tree = (files: Record<string, string>, withSites = true) => {
  root = mkdtempSync(join(tmpdir(), 'mica-usage-'));
  if (withSites) files = { 'web/src/sites.ts': SITES, ...files };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const catalogs = (namespace: string, keys: string[]) =>
  new Map([
    [
      namespace,
      new Map([
        [
          'en',
          { path: `${namespace}/en.json`, entries: Object.fromEntries(keys.map((k) => [k, 'x'])) }
        ]
      ])
    ]
  ]);

const unused = (namespace: string, keys: string[]) =>
  findUnusedKeys(root, catalogs(namespace, keys)).map((k) => k.full);

describe('findUnusedKeys', () => {
  it('flags a key nothing reads and keeps one that is read', () => {
    tree({ 'web/src/a.ts': "t('notes.used')" });
    expect(unused('notes', ['used', 'dead'])).toEqual(['notes.dead']);
  });

  it('does not read a longer key as the shorter one', () => {
    tree({ 'web/src/a.ts': "t('notes.savedAll')" });
    expect(unused('notes', ['saved'])).toEqual(['notes.saved']);
  });

  it('counts a plural base as reading every category', () => {
    tree({ 'web/src/a.ts': "plural('notes.count', n)" });
    expect(unused('notes', ['count.one', 'count.other', 'other.one'])).toEqual(['notes.other.one']);
  });

  it('does not count a test, or a comment, as reading a key', () => {
    tree({
      'web/src/a.test.ts': "t('notes.intest')",
      'web/src/b.ts': "// t('notes.inline')\n/* t('notes.block') */\nexport {};"
    });
    expect(unused('notes', ['intest', 'inline', 'block'])).toEqual([
      'notes.block',
      'notes.inline',
      'notes.intest'
    ]);
  });

  it('excuses a run-time family while the template that builds it exists', () => {
    tree({});
    expect(unused('store', ['permission.camera', 'needs.money'])).toEqual([]);
    expect(unused('store', ['permission.camera', 'unrelated'])).toEqual(['store.unrelated']);
  });

  it('throws when a family call site is gone, rather than keep excusing it', () => {
    tree({ 'web/src/a.ts': 'export {};' }, false);
    expect(() => unused('notes', ['k'])).toThrow(/no longer has its call site/);
  });

  it('throws on a tree with no source', () => {
    tree({ 'README.md': 'x' }, false);
    expect(() => unused('notes', ['k'])).toThrow(/no source files/);
  });

  it('throws on catalogs with no keys', () => {
    tree({});
    expect(() => findUnusedKeys(root, new Map())).toThrow(/no keys/);
  });
});

describe('stripComments', () => {
  it('keeps a URL and removes a line, block and HTML comment', () => {
    expect(stripComments("a('https://x.y') // gone\n/* gone */b<!-- gone -->c")).toBe(
      "a('https://x.y') \nbc"
    );
  });
});
