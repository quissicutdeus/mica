// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

import { LICENSE_BANNER } from '../scripts/license-banner.js';

// MICA-302. The in-server integration suite: a second FiveM resource, `mica-integration`,
// that `scripts/deploy/mica-smoke-release.sh` ensures after `mica` in a real FXServer
// against a real MariaDB. It is built apart from the two bundles in `build-bundle.js` and
// lands in `dist/integration/`, which `scripts/pack-resource.js` never reads -- the release
// zip must not carry it, and the packer refuses one that does.
//
//   dist/integration/mica-integration/server.js       the bundle
//   dist/integration/mica-integration/fxmanifest.lua  integration/fxmanifest.lua, verbatim
//
// It is part of `pnpm build:nocheck`, so `pnpm verify` builds it on every push. A suite that
// only built on `main`, inside the release job, would first fail where it blocks a release.

const ENTRY = 'integration/server.ts';
const MANIFEST = 'integration/fxmanifest.lua';
const OUT_DIR = 'dist/integration/mica-integration';

const missing = [ENTRY, MANIFEST].filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(
    `build-integration: missing ${missing.join(', ')}. There is no suite to build without ` +
      'them, and building nothing is not a pass.'
  );
  process.exit(1);
}

try {
  const { errors } = await build({
    logLevel: 'info',
    bundle: true,
    charset: 'utf8',
    absWorkingDir: process.cwd(),
    // Same runtime as the `mica` server bundle: FXServer's Node 22 (`node_version '22'`).
    target: 'node22',
    platform: 'node',
    entryPoints: [ENTRY],
    outfile: join(OUT_DIR, 'server.js'),
    // `scripts/check-license-banner.js` reads every .js under dist/, this one included.
    banner: { js: LICENSE_BANNER }
  });
  if (errors.length > 0) {
    console.error(`build-integration: bundle failed with ${errors.length} errors`);
    process.exit(1);
  }
} catch (error) {
  console.error('build-integration: build failed');
  console.error(error);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(MANIFEST, join(OUT_DIR, 'fxmanifest.lua'));
console.log(`build-integration: ${OUT_DIR}/{server.js,fxmanifest.lua}`);
