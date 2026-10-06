// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The game build contains no trace of the dev add-on path (MICA-311).
 *
 * `?addonDev=<loopback URL>` loads an add-on from the author's own machine into the
 * sandboxed frame. It exists only where a build flag allows it -- Vite's `DEV` and the
 * public demo image, which sets `VITE_MICA_ADDON_DEV=1` -- and the build a player's game
 * loads (`pnpm build`, `build:nocheck`, the release zip) must carry none of it. The code is
 * imported behind that condition and is meant to be folded away with its chunk; whether Vite
 * 8's bundler really does is a property of the emitted files, not of the source, so this
 * reads the files.
 *
 * It scans every byte of `dist/web` for the marker the dev path carries at runtime
 * (`MICA_DEV_ADDON_MARKER` in `shared/addonDev.ts`) and names each file holding it. It runs
 * at the end of `build:nocheck`, and before `pack:resource` packs, for the reason
 * `check-license-banner.js` does: `pnpm verify` runs unit tests before the build, so a test
 * reading `dist/` would find nothing and skip.
 *
 * Absence of output is a failure here, never a pass. A missing directory, an empty one, or
 * one with no `index.html` means the check had nothing to look at -- a broken pipeline, or
 * a path that moved -- and "found no marker in no files" reads exactly like a clean build.
 *
 *   node scripts/check-no-dev-addon.js [dir]     default dist/web
 */

/**
 * Spelled out here rather than imported: `shared/addonDev.ts` is TypeScript and this runs
 * under plain node, and a marker the check reads from the code it polices could be edited
 * away together with the thing it guards. If the constant there changes, change this too.
 */
const MARKER = 'mica-dev-addon';

// Relative to the working directory, as `pack-resource.js` reads `dist/` -- both run from the
// repo root, and a packer that scanned one tree while archiving another would be no gate.
const target = resolve(process.argv[2] ?? join('dist', 'web'));
const shown = relative(process.cwd(), target) || '.';

const fail = (message) => {
  console.error(`check-no-dev-addon: ${message}`);
  process.exit(1);
};

const walk = (dir) => {
  let out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
};

if (!existsSync(target) || !statSync(target).isDirectory()) {
  fail(
    `${shown} does not exist. This runs after the web build and has nothing to check without ` +
      'one, which is a broken pipeline rather than a pass.'
  );
}

const files = walk(target);

if (files.length === 0) {
  fail(`${shown} is empty. Reporting that rather than reporting that no file contains the marker.`);
}

if (!existsSync(join(target, 'index.html'))) {
  fail(
    `${shown} has ${files.length} files but no index.html, so it is not a web build and ` +
      'whatever it holds says nothing about the one the game loads.'
  );
}

// Bytes, not text: a `.map`, a `.woff2` or a compressed sidecar is read the same way, and a
// marker split across a decode boundary cannot slip through.
const needle = Buffer.from(MARKER);
const found = files.filter((file) => readFileSync(file).includes(needle));

if (found.length > 0) {
  fail(
    `${found.length} of ${files.length} files in ${shown} contain "${MARKER}":\n` +
      found.map((file) => `  ${relative(process.cwd(), file)}`).join('\n') +
      '\n\nThe dev add-on path must exist only where `import.meta.env.DEV` or ' +
      '`VITE_MICA_ADDON_DEV=1` allows it. Either the game build was run with that variable ' +
      'set, or the code behind the condition is no longer folded away -- check how it is ' +
      'imported before suspecting the variable.'
  );
}

console.log(`check-no-dev-addon: ${files.length} files in ${shown}, none containing the marker.`);
