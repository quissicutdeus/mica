// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { format, resolveConfig } from 'prettier';

/**
 * The language files an owner edits without rebuilding (MICA-235), written from the catalogs
 * the phone bundles. Kept apart from `scripts/generate-locales.js` so
 * `server/__tests__/generateLocales.test.ts` can hold it.
 *
 * On disk: `locales/<lang>/<namespace>.json`, one flat `{ key: string }` per namespace, keys
 * without the namespace prefix. The server reads the folder at start; `en` is the reference a
 * translator copies and the one missing keys are measured against.
 */

/** The output directory at the repository root, packed into the zip at `mica/locales/`. */
export const LOCALES_DIR = 'locales';

/**
 * The languages the phone ships catalogs for, and so the only ones this writes or prunes.
 * Any other directory under `locales/` is an owner's translation and is never touched.
 */
export const BUNDLED_LANGS = ['en', 'de'];

/** The namespaces that are not app ids, so an app with one of these ids is refused. */
const RESERVED = ['shell', 'server', 'ui'];

/**
 * Where each kind of catalog lives, as a glob and the namespace a match belongs to. Found by
 * glob so a new app -- core or add-on, both live in `web/src/apps` -- is picked up without
 * editing this file.
 */
const SOURCES = [
  {
    glob: 'web/src/apps/*/locales/*.json',
    namespace: (file) => basename(dirname(dirname(file))),
    lang: (file) => basename(file, '.json')
  },
  {
    glob: 'web/src/shell/locales/*.json',
    namespace: (file) => (basename(file).startsWith('server.') ? 'server' : 'shell'),
    lang: (file) => basename(file, '.json').replace(/^server\./, '')
  },
  {
    glob: 'sdk/ui/locales/*.json',
    namespace: () => 'ui',
    lang: (file) => basename(file, '.json')
  }
];

const LANG = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/**
 * Every bundled catalog, as `Map<namespace, Map<lang, { path, entries }>>`. Throws, naming
 * the file, on anything it would otherwise have to guess about: a language outside
 * `BUNDLED_LANGS` (it would be silently dropped), a catalog that is not a flat object of
 * strings, a namespace with no `en`, an app id that collides with a reserved namespace, or a
 * required namespace with no catalog at all.
 */
export function discoverCatalogs(root) {
  const catalogs = new Map();
  for (const source of SOURCES) {
    for (const path of globSync(source.glob, { cwd: root }).sort()) {
      const namespace = source.namespace(path);
      const lang = source.lang(path);
      if (!LANG.test(lang)) throw new Error(`${path}: '${lang}' is not a language code.`);
      if (!BUNDLED_LANGS.includes(lang)) {
        throw new Error(
          `${path}: '${lang}' is not one of ${BUNDLED_LANGS.join(', ')}. Add it to ` +
            'BUNDLED_LANGS in scripts/lib/locales.js, or it would be left out of locales/.'
        );
      }
      if (source.glob.startsWith('web/src/apps') && RESERVED.includes(namespace)) {
        throw new Error(`${path}: the app id '${namespace}' is a reserved locale namespace.`);
      }
      const entries = JSON.parse(readFileSync(join(root, path), 'utf8'));
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new Error(`${path}: a catalog must be a flat JSON object.`);
      }
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== 'string') {
          throw new Error(`${path}: '${key}' is not a string; catalogs are flat { key: string }.`);
        }
      }
      if (!catalogs.has(namespace)) catalogs.set(namespace, new Map());
      const langs = catalogs.get(namespace);
      if (langs.has(lang)) {
        throw new Error(`${path}: a second '${lang}' catalog for '${namespace}'.`);
      }
      langs.set(lang, { path, entries });
    }
  }

  for (const required of RESERVED) {
    if (!catalogs.has(required)) {
      throw new Error(`no catalog found for the '${required}' namespace; did a source move?`);
    }
  }
  if (catalogs.size === RESERVED.length) {
    throw new Error('no app catalogs found under web/src/apps/*/locales; did they move?');
  }
  for (const [namespace, langs] of catalogs) {
    if (!langs.has('en')) {
      throw new Error(`'${namespace}' has no en catalog, and en is the reference language.`);
    }
  }
  return catalogs;
}

/**
 * Every file `locales/` should hold for the bundled languages, as `Map<relativePath,
 * contents>`, formatted by Prettier with the repository's own options so `format:check`
 * and this agree about every byte.
 */
export async function renderLocales(root) {
  const catalogs = discoverCatalogs(root);
  const out = new Map();
  for (const namespace of [...catalogs.keys()].sort()) {
    for (const [lang, { entries }] of catalogs.get(namespace)) {
      const path = join(LOCALES_DIR, lang, `${namespace}.json`);
      const filepath = join(root, path);
      const options = (await resolveConfig(filepath)) ?? {};
      out.set(path, await format(JSON.stringify(entries), { ...options, filepath }));
    }
  }
  return out;
}

/** The `.json` files under `locales/<lang>/` for the bundled languages, as they are on disk. */
export function existingLocales(root) {
  const out = new Map();
  for (const lang of BUNDLED_LANGS) {
    const dir = join(root, LOCALES_DIR, lang);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(LOCALES_DIR, lang, file);
      out.set(path, readFileSync(join(root, path), 'utf8'));
    }
  }
  return out;
}

/** What differs between the tree and the catalogs: `{ missing, changed, stale }`, as paths. */
export function diffLocales(expected, existing) {
  const missing = [...expected.keys()].filter((p) => !existing.has(p));
  const changed = [...expected.keys()].filter(
    (p) => existing.has(p) && existing.get(p) !== expected.get(p)
  );
  const stale = [...existing.keys()].filter((p) => !expected.has(p));
  return { missing, changed, stale };
}
