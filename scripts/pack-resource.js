// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import {
  DIST_DIRS,
  RESOURCE_NAME,
  TOP_LEVEL_FILES,
  calVerFromGit,
  calVerOf,
  readmeExcerpt,
  releaseDate,
  stampManifestVersion,
  uncoveredGlobs,
  zipName
} from './lib/release-zip.js';
import { createZip } from './lib/zip.js';

/**
 * Pack the built resource as `dist/release/gphone-<calver>.zip` (MICA-220).
 *
 * Installing gPhone used to mean a clone, a `pnpm install` and a `pnpm build` on Node 26 --
 * `dist/` is gitignored, so the repository alone is not a resource. The FiveM audience
 * downloads a zip and writes `ensure gphone`, and a toolchain requirement is where most of
 * them stop. This is the zip: unpack it into `resources/` and the directory it leaves is
 * the resource, manifest, bundles, both schema files, the licence and a README beside them.
 *
 * ## It archives; it does not build
 *
 * `pnpm build:nocheck` has to have run first, and this refuses rather than running it: the
 * build has its own gate in `scripts/verify.js` and its own failures, and a packer that
 * quietly built would report a broken build as a packing error. In `release.yml` the build
 * is the step before; in `pnpm verify` this is the `pack` gate after `build`.
 *
 * ## The zip is checked against the manifest
 *
 * FiveM serves only what `fxmanifest.lua` lists. A directory the build stopped emitting
 * would still zip cleanly and still `ensure` cleanly, and fail on the first request for a
 * file that is not there -- which is exactly how every add-on 404'd once, when `assets/**`
 * did not cover them. So every glob the manifest declares has to match at least one packed
 * path, or this exits non-zero naming the ones that do not.
 *
 * ## Reproducible
 *
 * Entries are sorted and stamped with the tag's date, so packing the same build twice gives
 * the same bytes and the checksum in `SHA256SUMS` describes the tree rather than the moment.
 *
 *   node scripts/pack-resource.js v2026.09.02.3   the tag release.yml computed
 *   node scripts/pack-resource.js                 the CalVer of HEAD, for a local pack
 */

const OUT = 'dist/release';

const tag = process.argv[2] ?? `v${calVerFromGit()}`;
let version;
try {
  version = calVerOf(tag);
} catch (error) {
  console.error(`pack-resource: ${error.message}`);
  process.exit(1);
}

/** What a build leaves behind. Any one missing means no build ran, or a broken one did. */
const REQUIRED = [
  'dist/client/client.js',
  'dist/server/server.js',
  'dist/web/index.html',
  // The add-on bundles, built by `web/scripts/build-addons.mjs` ahead of the shell. The
  // manifest declares them and the Store installs from them, so a zip without the directory
  // is a phone whose add-ons 404 -- the bug the manifest's own comment records.
  'dist/web/addons'
];
const missing = REQUIRED.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(
    `pack-resource: no build to pack -- missing ${missing.join(', ')}. Run \`pnpm build\` ` +
      '(or `pnpm build:nocheck`) first; this archives what the build produced and never ' +
      'builds on its own, so a broken build fails at the build gate rather than here.'
  );
  process.exit(1);
}

const walk = (dir) => {
  let out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
};

/** Paths relative to the resource root, `/`-separated whatever the host uses. */
const relPaths = DIST_DIRS.flatMap((dir) => walk(dir)).map((file) =>
  relative('.', file).split('\\').join(posix.sep)
);
const manifest = readFileSync('fxmanifest.lua', 'utf8');

const uncovered = uncoveredGlobs(manifest, relPaths);
if (uncovered.length > 0) {
  console.error(
    'pack-resource: fxmanifest.lua declares paths the build did not produce, so the zip ' +
      `would start and then 404: ${uncovered.join(', ')}`
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
if (!repository) {
  console.error('pack-resource: package.json has no `repository` URL for the README to point at.');
  process.exit(1);
}

const entries = [
  ...relPaths.map((path) => ({ path, data: readFileSync(path) })),
  ...TOP_LEVEL_FILES.map((path) => ({
    path,
    data: path === 'fxmanifest.lua' ? stampManifestVersion(manifest, version) : readFileSync(path)
  })),
  { path: 'README.md', data: readmeExcerpt(readFileSync('README.md', 'utf8'), { tag, repository }) }
].map(({ path, data }) => ({ path: `${RESOURCE_NAME}/${path}`, data }));

const zip = createZip(entries, { mtime: releaseDate(tag) });

mkdirSync(OUT, { recursive: true });
const name = zipName(tag);
writeFileSync(join(OUT, name), zip);
console.log(
  `pack-resource: ${name} (${entries.length} files, ${Math.round(zip.length / 1024)} KB) -> ${OUT}/${name}`
);
