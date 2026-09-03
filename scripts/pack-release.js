// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { releaseManifest } from './lib/release-manifest.js';

/**
 * Pack `@gos/sdk` and `@gos/shared` as tarballs for a GitHub Release.
 *
 * MICA-125 asked for a published, versioned contract someone outside this repo can build
 * against. This is that, without an npm name. The decision and its reasoning are on the
 * ticket; the short version is that an npm name is permanent, publishing means maintaining
 * two packages in lockstep forever, and the git-dependency path that MICA-175 proved
 * already works — so a versioned artifact attached to the release that already exists gets
 * the benefit and leaves the one-way door shut.
 *
 * **Both packages, always.** `@gos/sdk` depends on `@gos/shared`, and `sdk/types.ts`
 * re-exports from it into both barrels, so a consumer resolving the SDK alone gets a 404 on
 * a dependency it cannot see. Shipping one without the other is shipping neither.
 *
 * ## The version
 *
 * `<contract>.<yyyymmdd>.<n>` — for tag `v2026.08.31.3`, that is `1.20260831.3`.
 *
 * The major is `SDK_CONTRACT_VERSION`, read from `sdk/version.ts` rather than restated, so
 * the number a consumer installs and the number an add-on branches on cannot disagree. It
 * moves only on a break, which is exactly what a major is for.
 *
 * The rest is the release's CalVer, flattened. It is a build stamp and does not claim to be
 * semantic: this repo has no per-release judgement about "addition" versus "fix" to encode,
 * and inventing one that nobody applies would make the number lie. Monotonic and orderable
 * is what a consumer needs to pin and compare, and this is both. `sdk/version.ts` remains
 * the place where meaning lives.
 *
 * Note what this replaces: `package.json`'s `1.0.0`, which `sdk/version.ts` calls "a
 * placeholder read by no code". Every tarball this produces carries a real version instead.
 *
 * ## Non-destructive
 *
 * The version rewrite is undone before this exits, so running it locally to inspect a
 * tarball does not leave edited manifests behind. CI's checkout is disposable and would not
 * care; a developer's tree would.
 */

const PACKAGES = ['sdk', 'shared'];
const OUT = 'dist/release';

const tag = process.argv[2];
if (!tag || !/^v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag)) {
  console.error(
    `pack-release: expected a CalVer tag like v2026.08.31.3, got ${tag ?? '(nothing)'}.\n` +
      'It is the tag `release.yml` computed, and the version below is derived from it.'
  );
  process.exit(1);
}

/** Read from source, never restated: the two must not be able to disagree. */
const contractVersion = (() => {
  const source = readFileSync('sdk/version.ts', 'utf8');
  const found = /SDK_CONTRACT_VERSION:\s*string\s*=\s*'([^']+)'/.exec(source)?.[1];
  if (!found) {
    console.error(
      'pack-release: could not read SDK_CONTRACT_VERSION from sdk/version.ts. That is the ' +
        'major version of everything this publishes, so this refuses to guess it.'
    );
    process.exit(1);
  }
  return found;
})();

const [, date, count] = /^v(\d{4}\.\d{2}\.\d{2})\.(\d+)$/.exec(tag);
const version = `${contractVersion}.${date.replaceAll('.', '')}.${count}`;

const manifests = PACKAGES.map((dir) => {
  const path = join(dir, 'package.json');
  return { dir, path, original: readFileSync(path, 'utf8') };
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

try {
  for (const { path, original } of manifests) {
    writeFileSync(path, releaseManifest(original, version));
  }

  // `releaseManifest` has already turned the SDK's `workspace:*` dependency on
  // `@gos/shared` into this same version, so both tarballs agree and neither needs a
  // workspace to be understood. That rewrite used to be left to `pnpm pack`, which cannot
  // do it without an install — see `lib/release-manifest.js` for what that cost.
  for (const { dir } of manifests) {
    execFileSync('pnpm', ['pack', '--pack-destination', join(process.cwd(), OUT)], {
      cwd: dir,
      stdio: 'inherit'
    });
  }
} finally {
  for (const { path, original } of manifests) writeFileSync(path, original);
}

console.log(`pack-release: ${version} -> ${OUT}`);
