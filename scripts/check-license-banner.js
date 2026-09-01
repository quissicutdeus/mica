// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { LICENSE_BANNER } from '../build/license-banner.js';

/**
 * Every emitted `.js` starts with the licence notice, checked against the files rather than
 * the configuration that was supposed to produce them (MICA-192).
 *
 * This runs at the end of `build:nocheck` rather than as a unit test, and the reason is the
 * ordering in `scripts/verify.js`: `unit` runs *before* `build`, so a test that reads `dist/`
 * finds nothing in a clean CI checkout and skips. A check that answers "no output to
 * inspect, carry on" is the failure mode AGENTS.md names — silence that reads as a pass —
 * and it would have hidden both of the bugs this exists to catch.
 *
 * Both were invisible in the config and obvious in the output:
 *
 * - **Vite 8 bundles rolldown, which ignores `build.rollupOptions.output.banner`.** Setting
 *   it changed nothing in 28 chunks, with no warning, while esbuild's own `banner` worked on
 *   the two it builds. Nothing about the config said which of the two would be honoured.
 * - **A `generateBundle` hook at the normal stage is overwritten by every post-stage one.**
 *   Vite's `__vite__mapDeps` prologue and `vite.addon.config.ts`'s CSS injector both prepend
 *   to `chunk.code`, so the banner ended up on line 3 of five files and first in the other
 *   twenty-nine — a shape no reasonable spot-check would have found.
 */

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

const emittedJs = (dir) => {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(emittedJs(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
};

let files;
try {
  files = emittedJs(DIST);
} catch {
  console.error(
    `check-license-banner: ${relative(ROOT, DIST)} does not exist. This runs after the build ` +
      'and has nothing to check without one, which is a broken pipeline rather than a pass.'
  );
  process.exit(1);
}

if (files.length === 0) {
  console.error(
    'check-license-banner: the build emitted no .js at all. Reporting that rather than ' +
      'reporting that every file it found carries the banner.'
  );
  process.exit(1);
}

const missing = files
  .filter((file) => !readFileSync(file, 'utf8').startsWith(LICENSE_BANNER))
  .map((file) => relative(ROOT, file));

if (missing.length > 0) {
  console.error(
    `check-license-banner: ${missing.length} of ${files.length} emitted files do not start ` +
      'with the licence banner:\n' +
      missing.map((file) => `  ${file}`).join('\n') +
      '\n\nThe banner is applied by `licenseBanner()` in build/license-banner.js, which every ' +
      'build that emits JavaScript has to include — esbuild via `banner`, and each Vite ' +
      'config via the plugin. A new bundle target needs wiring; an existing one that stopped ' +
      'working is usually a hook that now runs before a post-stage one.'
  );
  process.exit(1);
}

console.log(`check-license-banner: ${files.length} emitted files, all carrying the notice.`);
