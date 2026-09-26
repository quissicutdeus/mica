// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  BUNDLED_LANGS,
  diffLocales,
  discoverCatalogs,
  existingLocales,
  renderLocales
  // @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
} from '../../scripts/lib/locales.js';

/**
 * `locales/`, the language files an owner edits without a rebuild (MICA-235), generated from
 * the catalogs the phone bundles. The `locales` gate of `pnpm verify` runs the generator's
 * `--check` over the real tree; this suite holds the rules that gate relies on.
 */

const ROOT = resolve(__dirname, '../..');

describe('the committed locales/', () => {
  it('is exactly what the bundled catalogs generate', async () => {
    const diff = diffLocales(await renderLocales(ROOT), existingLocales(ROOT));
    expect(diff).toEqual({ missing: [], changed: [], stale: [] });
  });

  it('has one namespace per app with a catalog, plus shell, server and ui', () => {
    const apps = globSync('web/src/apps/*/locales/en.json', { cwd: ROOT }).map((p) =>
      basename(dirname(dirname(p)))
    );
    expect(apps.length).toBeGreaterThan(0);
    expect([...discoverCatalogs(ROOT).keys()].sort()).toEqual(
      [...apps, 'server', 'shell', 'ui'].sort()
    );
  });

  it('keeps each catalog flat and unprefixed, key for key', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/server.json'), 'utf8'));
    const source = JSON.parse(
      readFileSync(join(ROOT, 'web/src/shell/locales/server.en.json'), 'utf8')
    );
    expect(en).toEqual(source);
    expect(Object.keys(en)).toEqual(Object.keys(source));
  });
});

describe('the generator, on a scratch tree', () => {
  let root: string;
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const seed = () => {
    root = mkdtempSync(join(tmpdir(), 'mica-locales-'));
    put('web/src/apps/notes/locales/en.json', { title: 'Notes' });
    put('web/src/apps/notes/locales/de.json', { title: 'Notizen' });
    put('web/src/shell/locales/en.json', { home: 'Home' });
    put('web/src/shell/locales/server.en.json', { generic: 'Something went wrong.' });
    put('sdk/ui/locales/en.json', { cancel: 'Cancel' });
  };

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes one file per namespace and bundled language', async () => {
    seed();
    const out = await renderLocales(root);
    expect([...out.keys()].sort()).toEqual([
      'locales/de/notes.json',
      'locales/en/notes.json',
      'locales/en/server.json',
      'locales/en/shell.json',
      'locales/en/ui.json'
    ]);
    expect(JSON.parse(out.get('locales/de/notes.json'))).toEqual({ title: 'Notizen' });
    expect(BUNDLED_LANGS).toEqual(['en', 'de']);
  });

  it('calls a namespace nobody generates stale, and never looks at another language', async () => {
    seed();
    put('locales/en/removed-app.json', { title: 'Gone' });
    put('locales/fr/notes.json', { title: 'Notes (fr)' });
    const existing = existingLocales(root);
    expect([...existing.keys()]).toEqual(['locales/en/removed-app.json']);
    expect(diffLocales(await renderLocales(root), existing)).toEqual({
      missing: [
        'locales/de/notes.json',
        'locales/en/notes.json',
        'locales/en/server.json',
        'locales/en/shell.json',
        'locales/en/ui.json'
      ],
      changed: [],
      stale: ['locales/en/removed-app.json']
    });
  });

  it('sees a hand edit as a change', async () => {
    seed();
    const out = await renderLocales(root);
    for (const [path, text] of out) put(path, text);
    put('locales/en/ui.json', { cancel: 'Nope' });
    expect(diffLocales(out, existingLocales(root)).changed).toEqual(['locales/en/ui.json']);
  });

  it.each([
    [
      'a required namespace has no catalog',
      () => rmSync(join(root, 'sdk'), { recursive: true }),
      /'ui'/
    ],
    [
      'no app has a catalog',
      () => rmSync(join(root, 'web/src/apps'), { recursive: true }),
      /no app catalogs/
    ],
    [
      'a language would be dropped',
      () => put('web/src/apps/notes/locales/fr.json', { title: 'Notes' }),
      /'fr' is not one of en, de/
    ],
    [
      'a value is not a string',
      () => put('web/src/apps/notes/locales/en.json', { title: { nested: 'x' } }),
      /not a string/
    ],
    [
      'a namespace has no en',
      () => rmSync(join(root, 'web/src/apps/notes/locales/en.json')),
      /'notes' has no en/
    ],
    [
      'an app id takes a reserved namespace',
      () => put('web/src/apps/ui/locales/en.json', { x: 'y' }),
      /reserved locale namespace/
    ]
  ])('refuses when %s, rather than writing a partial set', async (_label, breakIt, message) => {
    seed();
    breakIt();
    await expect(renderLocales(root)).rejects.toThrow(message);
  });
});
