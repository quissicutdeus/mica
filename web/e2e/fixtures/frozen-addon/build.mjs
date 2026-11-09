// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The recipe for `frozenprobe.js` (MICA-462). Read RECIPE.md first: this is run once, by the
// owner, and the output is committed. Nothing in the suite runs it.
//
//   node web/e2e/fixtures/frozen-addon/build.mjs <empty scratch dir>
//
// It copies the out-of-tree template to the scratch dir, lays `src/` over the template's own,
// links `@mica/sdk` and `@mica/shared` to THIS checkout and the toolchain to `web/`'s copies,
// and runs the template's own `vite.config.ts` in production mode, as `pnpm build` would for
// an author. Whatever the checkout's sha is, is the sha the bundle is built from.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const TEMPLATE_DIR = path.join(ROOT, 'tools/addon-template');
const HERE = import.meta.dirname;
const VITE_BIN = path.join(ROOT, 'web/node_modules/vite/bin/vite.js');
const TOOLCHAIN = [
  'vite',
  'svelte',
  'postcss',
  'postcss-preset-env',
  'autoprefixer',
  '@sveltejs/vite-plugin-svelte',
  '@tsconfig/svelte'
];
const ID = 'frozenprobe';

const out = process.argv[2];
if (!out) throw new Error('usage: build.mjs <empty scratch dir>');
const dir = path.resolve(out);
if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
  throw new Error(`${dir} is not empty`);
}
fs.mkdirSync(dir, { recursive: true });

fs.cpSync(TEMPLATE_DIR, dir, {
  recursive: true,
  filter: (src) =>
    !/^(node_modules|dist|dist-dev|src)(\/|\\|$)/.test(path.relative(TEMPLATE_DIR, src))
});
fs.cpSync(path.join(HERE, 'src'), path.join(dir, 'src'), {
  recursive: true,
  filter: (src) => !src.endsWith('.svelte.src')
});
for (const file of fs
  .readdirSync(path.join(HERE, 'src'))
  .filter((f) => f.endsWith('.svelte.src'))) {
  fs.copyFileSync(path.join(HERE, 'src', file), path.join(dir, 'src', file.slice(0, -4)));
}
const link = (name, target) => {
  const at = path.join(dir, 'node_modules', name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'dir');
};
link('@mica/sdk', path.join(ROOT, 'sdk'));
link('@mica/shared', path.join(ROOT, 'shared'));
for (const name of TOOLCHAIN)
  link(name, fs.realpathSync(path.join(ROOT, 'web/node_modules', name)));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV'));
execFileSync(process.execPath, [VITE_BIN, 'build'], { cwd: dir, env, stdio: 'inherit' });

const bundle = fs.readFileSync(path.join(dir, 'dist', `${ID}.js`));
const sha256 = createHash('sha256').update(bundle).digest('hex');
const entry = {
  id: ID,
  name: 'Frozen Probe',
  version: '1.0.0',
  description: 'A bundle frozen against SDK contract version 1.',
  bundleUrl: `${ID}.js`,
  sha256,
  color: 'bg-yellow-400',
  // Narrower than the manifest in src/, on purpose: `contacts` is declared there and not here.
  permissions: ['notifications'],
  sdkContract: '1'
};
fs.writeFileSync(path.join(dir, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
console.log(`built ${path.join(dir, 'dist', `${ID}.js`)}\nsha256 ${sha256}`);
