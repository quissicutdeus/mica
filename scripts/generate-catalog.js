// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderAppIcons } from './lib/app-icons.js';
import { writePublicCatalog } from './lib/public-catalog.js';

/**
 * Emit a `catalog.json` describing the add-on bundles that were just built.
 *
 * The Store installs from a catalog, and until now nothing produced one — MICA-126 built
 * the whole install path (fetch, host allowlist, SHA-256 verification, sandboxed boot) and
 * left it reachable only by hand-writing JSON. This is what lets the demo host its own, so
 * the loop is exercised by every deploy rather than by somebody remembering to.
 *
 * ## The manifests are evaluated, not parsed
 *
 * A `CatalogEntry` needs `name`, `version` and `color`. An add-on manifest mostly declares
 * none of them: `defineApp` defaults `name` from the id, derives `color` from `tile`, and
 * supplies `version`. Reading those out of the source text would mean reimplementing
 * `defineApp`'s defaulting here, in a regex, and that second copy would drift — quietly,
 * and into a file that decides what players are offered.
 *
 * So each manifest is bundled with esbuild and imported, and the catalog is built from the
 * object `defineApp` actually returned. `.svelte` imports are stubbed in *that* bundle: it
 * exists to read a manifest object, and a component is not part of one.
 *
 * ## The icon is rendered, not referenced
 *
 * A manifest's `icon` is a component and `CatalogEntry.icon` is a string, so each
 * `Icon.svelte` is compiled, rendered to static SVG and inlined as a `data:` URI. That
 * lives in `scripts/lib/app-icons.js`, which carries the reasoning and can be tested
 * without a built `dist/`; omitting it is what left a catalog install with a coloured tile
 * and no glyph.
 *
 * ## What it refuses to do
 *
 * Guess. A manifest that does not yield every required field fails the build rather than
 * emitting a row that `isCatalogEntry` will silently drop at runtime — a dropped row is an
 * app missing from the Store with no explanation, which is worse than a red build.
 *
 * `sha256` is computed over the exact bytes on disk. That is the whole point of the field:
 * the shell re-hashes what it fetched and refuses a mismatch, so a catalog whose hash was
 * copied rather than computed turns every install into a failure.
 *
 * ## Two catalogs, two audiences (MICA-237)
 *
 * The demo's catalog above lists every in-tree add-on and is served under `/demo/addons/`
 * for the demo's own Store. The *public* catalog is a different file for a different
 * reader: a stock server's Store points at `https://mica.gg/addons/sdk-<contract>/catalog.json`
 * and lists only add-ons the resource does not already ship (`lib/public-catalog.js`).
 * `--public <siteDir>` writes it under the site root. It is independent of the demo's
 * origin and build stamp -- every image serves it, including the ones that skip the demo
 * catalog -- so it can be given alone, with no origin.
 *
 *   node scripts/generate-catalog.js <origin> [outDir] [root] [--public <siteDir>]
 *   node scripts/generate-catalog.js --public <siteDir> [outDir] [root]
 */

const cliArgs = process.argv.slice(2);
let publicDir;
const publicFlag = cliArgs.indexOf('--public');
if (publicFlag !== -1) {
  publicDir = cliArgs[publicFlag + 1];
  if (!publicDir || publicDir.startsWith('--')) {
    console.error('generate-catalog: --public needs the site directory to write under.');
    process.exit(1);
  }
  cliArgs.splice(publicFlag, 2);
}
// The origin is the first positional when there is one. Without `--public` it is required,
// so a bare run keeps failing loudly below rather than quietly writing nothing.
const origin =
  /^https?:\/\//.test(cliArgs[0] ?? '') || publicDir === undefined ? cliArgs.shift() : undefined;
const outDir = cliArgs[0] ?? 'dist/web/addons';
const rootArg = cliArgs[1] ?? '.';

/**
 * Where the bundles this catalog describes are actually served, relative to `origin`.
 *
 * MICA-221 moved the demo image's phone bundle from `/` to `/demo/` to make room for a
 * landing page at the root, and `docker/serve/main.go`'s `dist/site` assembly carries the
 * add-on bundles along with it -- they land at `/demo/addons/<id>.js`, not `/addons/<id>.js`.
 * This is the one place that path is spelled out for `bundleUrl`; `outDir` above is the
 * on-disk side of the same move and is passed in by the Dockerfile rather than assumed here,
 * since the two can drift independently (a hand run of this script can point `outDir`
 * anywhere).
 */
const BUNDLE_PATH_PREFIX = '/demo/addons';

if (publicDir === undefined || origin !== undefined) {
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) {
    console.error(
      `generate-catalog: expected an origin like https://dev.mica.gg, got ${origin ?? '(nothing)'}.\n` +
        '`bundleUrl` has to be absolute — the shell matches its host against the allowlist, so a\n' +
        'relative URL cannot be checked and is refused.'
    );
    process.exit(1);
  }
}

const root = resolve(rootArg);
const appsDir = join(root, 'web/src/apps');
const bundleDir = join(root, outDir);

/** Comments stripped first: a doc comment discussing `core: true` is not a declaration. */
const withoutComments = (source) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

const addOnIds = () =>
  readdirSync(appsDir).filter((id) => {
    const file = join(appsDir, id, 'manifest.ts');
    if (!existsSync(file)) return false;
    return /^\s*core:\s*false\s*,?\s*$/m.test(withoutComments(readFileSync(file, 'utf8')));
  });

/**
 * Stubs every `.svelte` import: this bundle exists to read manifest objects, and a
 * component is not part of one. The icons get their own pass — see `lib/app-icons.js`.
 *
 * CommonJS and a `Proxy`, not `export default`, and both halves are load-bearing. Reaching
 * `defineApp` pulls in SDK modules that take *named* imports from `.svelte` files —
 * `sdk/host/iframe/boot.ts` wants `liveAddOnProps` from one — and an ESM stub exporting
 * only a default fails the build on every one of them. esbuild cannot statically check the
 * exports of a CJS module, so it defers to runtime interop, and the `Proxy` answers to
 * whatever name is asked for. Nothing here is ever called: the manifest object is read and
 * the module graph is thrown away.
 */
const stubSvelte = {
  name: 'stub-svelte',
  setup(b) {
    b.onResolve({ filter: /\.svelte$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-svelte'
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub-svelte' }, () => ({
      contents: 'module.exports = new Proxy(function () {}, { get: () => function () {} });',
      loader: 'js'
    }));
  }
};

const ids = addOnIds();
if (ids.length === 0) {
  console.error(`generate-catalog: found no core:false apps under ${appsDir}.`);
  process.exit(1);
}

/**
 * esbuild, resolved from `web` rather than imported directly.
 *
 * It is a root devDependency, and the demo image installs with `--filter web...` precisely
 * to leave root devDependencies out — so a bare `import 'esbuild'` works on a developer's
 * machine and fails inside the container, which is the half that matters. `web` declares it
 * too (it is already there transitively, under Vite), and pnpm's non-flat layout means the
 * only way to reach that copy from this directory is to ask for it from over there.
 */
const { build } = await import(
  pathToFileURL(createRequire(join(root, 'web/package.json')).resolve('esbuild')).href
);

const work = mkdtempSync(join(tmpdir(), 'mica-catalog-'));
let manifests;
let isCatalogEntry;
let tileFromColorClasses;
let publicCatalogUrl;
try {
  const entry = join(work, 'entry.js');
  // `isCatalogEntry` comes out of the same bundle as the manifests, so what validates the
  // rows below is the shell's own validator rather than a second opinion about it.
  writeFileSync(
    entry,
    `${ids.map((id, i) => `import m${i} from ${JSON.stringify(join(appsDir, id, 'manifest.ts'))};`).join('\n')}
export { isCatalogEntry } from ${JSON.stringify(join(root, 'sdk/catalog.ts'))};
export { tileFromColorClasses } from ${JSON.stringify(join(root, 'sdk/manifest.ts'))};
export { publicAddonCatalogUrl } from ${JSON.stringify(join(root, 'shared/addonConfig.ts'))};
export { SDK_CONTRACT_VERSION } from ${JSON.stringify(join(root, 'sdk/version.ts'))};
export default [${ids.map((_, i) => `m${i}`).join(', ')}];`
  );

  const out = join(work, 'manifests.mjs');
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
    plugins: [stubSvelte],
    // No `alias` for `@mica/sdk`: since MICA-186 both it and `@mica/shared` are real
    // workspace packages, so ordinary resolution finds them through their `exports` maps.
    // An alias here would also be wrong rather than merely redundant — esbuild matches it
    // as a prefix, so mapping `@mica/sdk` at a file rewrites `@mica/sdk/app` into a
    // path underneath that file and fails to resolve it.
    absWorkingDir: root,
    conditions: ['import'],
    // `defineApp` branches on `import.meta.env.DEV`, which Vite substitutes and Node does
    // not have, so without this the import throws reading `DEV` of undefined. Production
    // values on purpose: what this needs is the manifest a shipped build would see.
    define: {
      'import.meta.env': JSON.stringify({
        DEV: false,
        PROD: true,
        MODE: 'production',
        SSR: false
      })
    }
  });

  const loaded = await import(pathToFileURL(out).href);
  manifests = loaded.default;
  isCatalogEntry = loaded.isCatalogEntry;
  // The tile's two roles, split by the same function `defineApp` splits them with, rather
  // than by a regex here that would drift from it.
  tileFromColorClasses = loaded.tileFromColorClasses;
  // The public catalog's URL is computed by the same function the server's default reads,
  // from the contract the phone enforces at install, so the file lands where that URL says.
  publicCatalogUrl = loaded.publicAddonCatalogUrl(loaded.SDK_CONTRACT_VERSION);

  // `render` is bundled alongside the components rather than imported separately: a server
  // component and the runtime that renders it have to be the same copy of Svelte's
  // internals, and esbuild gives each bundle its own.
} finally {
  rmSync(work, { recursive: true, force: true });
}

const REQUIRED = ['id', 'name', 'description', 'color'];

/**
 * What a bundle that ships with the phone claims as its version.
 *
 * `AppManifest.version` is optional and `defineApp` does not default it, because for the
 * phone's own apps there is nothing to default it to — `sdk/manifest.ts` puts it plainly:
 * "its version is the phone's own, and there is nowhere newer to get it". `CatalogEntry`,
 * on the other hand, requires the field, because a catalog exists so the Store can tell
 * whether what a player has is older than what is offered.
 *
 * So an app that states a version keeps it, and one that does not takes the build's. That
 * is the honest reading of the same sentence rather than a placeholder.
 */
const fallbackVersion = process.env.MICA_CALVER?.trim();

/**
 * The demo's own catalog: every in-tree add-on, served under `/demo/addons/`. Skipped when
 * there is no origin -- an image built without a branch or a stamp still gets the public
 * catalog below, which needs neither.
 */
if (origin) {
  /**
   * Every icon, rendered before the rows are built.
   *
   * One esbuild pass for all of them, so the map below stays synchronous. The tile's two
   * roles are split by the SDK's own `tileFromColorClasses` rather than by a regex here that
   * would drift from `defineApp`.
   */
  const icons = await renderAppIcons({
    root,
    appsDir,
    apps: manifests.map((manifest, i) => ({
      id: manifest.id ?? ids[i],
      fg: manifest.color ? tileFromColorClasses(manifest.color)?.fg : undefined
    }))
  }).catch((error) => {
    console.error(`generate-catalog: ${error.message}`);
    process.exit(1);
  });

  const entries = manifests.map((manifest, i) => {
    const id = manifest.id ?? ids[i];
    const bundle = join(bundleDir, `${id}.js`);
    if (!existsSync(bundle)) {
      console.error(
        `generate-catalog: ${id} has no bundle at ${bundle}. Build the add-ons first — a ` +
          'catalog entry whose bundle is missing is a Store listing that fails on install.'
      );
      process.exit(1);
    }

    const missing = REQUIRED.filter((field) => {
      const value = manifest[field];
      return typeof value !== 'string' || value.length === 0;
    });
    if (missing.length > 0) {
      console.error(
        `generate-catalog: ${id}'s manifest yielded no ${missing.join(', ')}. isCatalogEntry ` +
          'would drop this row at runtime and the app would be missing from the Store with ' +
          'nothing said, so this fails here instead.'
      );
      process.exit(1);
    }

    const version = manifest.version ?? fallbackVersion;
    if (!version) {
      console.error(
        `generate-catalog: ${id} states no version and MICA_CALVER is unset, so there is ` +
          'nothing honest to put in the entry. Set MICA_CALVER to the build stamp, or give ' +
          'the manifest a version of its own.'
      );
      process.exit(1);
    }

    return {
      id,
      name: manifest.name,
      version,
      description: manifest.description,
      bundleUrl: `${origin}${BUNDLE_PATH_PREFIX}/${id}.js`,
      sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      color: manifest.color,
      icon: icons[i],
      permissions: manifest.permissions ?? [],
      ...(manifest.requires ? { requires: manifest.requires } : {}),
      ...(manifest.devices ? { devices: manifest.devices } : {}),
      ...(manifest.requiresNetwork === undefined
        ? {}
        : { requiresNetwork: manifest.requiresNetwork }),
      ...(manifest.networkHosts ? { networkHosts: manifest.networkHosts } : {})
    };
  });

  /**
   * The shell's own validator, run over what is about to be written.
   *
   * `fetchCatalog` drops any row `isCatalogEntry` rejects and logs it, which is right at
   * runtime and useless here: the symptom is an app quietly missing from the Store. Every
   * field above is derived rather than typed, so the way to be sure the derivation is right
   * is to ask the thing that will judge it.
   */
  const rejected = entries.filter((entry) => !isCatalogEntry(entry)).map((entry) => entry.id);
  if (rejected.length > 0) {
    console.error(
      `generate-catalog: the shell's own isCatalogEntry rejects ${rejected.join(', ')}. ` +
        'Written out, those rows would be dropped on fetch and the apps would be absent from ' +
        'the Store with nothing said, so nothing is written.'
    );
    process.exit(1);
  }

  const path = join(bundleDir, 'catalog.json');
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`generate-catalog: ${entries.length} entries -> ${path} (origin ${origin})`);
}

/**
 * The public catalog, for a stock server's Store (MICA-237). See `lib/public-catalog.js` for
 * what it lists and why, and for the refusal when it would have to list something.
 */
if (publicDir !== undefined) {
  try {
    const written = writePublicCatalog({
      siteDir: resolve(root, publicDir),
      catalogUrl: publicCatalogUrl,
      ids,
      bundleDir
    });
    console.log(`generate-catalog: public catalog -> ${written} (${publicCatalogUrl})`);
  } catch (error) {
    console.error(`generate-catalog: ${error.message}`);
    process.exit(1);
  }
}
