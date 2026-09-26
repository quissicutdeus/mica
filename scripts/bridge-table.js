// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rewriteReadme } from './lib/bridge-table.js';

/**
 * Write README's bridge tables from `bridges/<name>/map.js` (MICA-232).
 *
 *   node scripts/bridge-table.js           rewrite the fenced regions in README.md
 *   node scripts/bridge-table.js --check   exit 1 if they differ from the bridges, or are gone
 *
 * `--check` runs as part of `pnpm lint:md`, so an entry added to a bridge without
 * regenerating README fails the markdown gate rather than shipping a table that lies.
 */

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, 'README.md');
const check = process.argv.includes('--check');

const readme = readFileSync(path, 'utf8');
let next;
try {
  next = await rewriteReadme(root, readme);
} catch (error) {
  console.error(`bridge-table: ${error.message}`);
  process.exit(1);
}

if (check) {
  if (next !== readme) {
    console.error(
      "bridge-table: README.md's bridge tables differ from bridges/*/map.js. Run " +
        '`pnpm generate:bridge-table` and commit the result.'
    );
    process.exit(1);
  }
  console.log('bridge-table: README.md matches bridges/*/map.js.');
} else if (next === readme) {
  console.log('bridge-table: README.md already up to date.');
} else {
  writeFileSync(path, next);
  console.log('bridge-table: rewrote the bridge tables in README.md.');
}
