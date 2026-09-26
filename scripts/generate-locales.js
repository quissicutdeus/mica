// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { diffLocales, existingLocales, renderLocales } from './lib/locales.js';

/**
 * Write `locales/en` and `locales/de` from the catalogs the phone bundles (MICA-235).
 *
 *   node scripts/generate-locales.js           rewrite them, deleting stale namespace files
 *   node scripts/generate-locales.js --check   exit 1 if they differ from the catalogs
 *
 * The output is committed, like `mica.sql`, and never hand-edited: an owner translating
 * copies `locales/en` to a new language directory, which this never reads, writes or
 * deletes. `--check` is the `locales` gate of `pnpm verify`, so a catalog changed without
 * regenerating fails there rather than shipping an `en` template that is missing keys.
 */

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

let expected;
try {
  expected = await renderLocales(root);
} catch (error) {
  console.error(`generate-locales: ${error.message}`);
  process.exit(1);
}

const { missing, changed, stale } = diffLocales(expected, existingLocales(root));

if (check) {
  if (missing.length + changed.length + stale.length > 0) {
    const list = (label, paths) => (paths.length ? `\n  ${label}: ${paths.join(', ')}` : '');
    console.error(
      'generate-locales: locales/ differs from the bundled catalogs. Run ' +
        '`pnpm generate:locales` and commit the result.' +
        list('missing', missing) +
        list('changed', changed) +
        list('stale', stale)
    );
    process.exit(1);
  }
  console.log(`generate-locales: locales/ matches the bundled catalogs (${expected.size} files).`);
} else {
  for (const path of [...missing, ...changed]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), expected.get(path));
  }
  for (const path of stale) rmSync(join(root, path));
  console.log(
    `generate-locales: ${expected.size} files; wrote ${missing.length + changed.length}, ` +
      `removed ${stale.length}.`
  );
}
