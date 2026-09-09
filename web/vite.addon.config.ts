import { defineConfig, type Plugin } from 'vite';
import { licenseBanner } from '../scripts/license-banner.js';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import path from 'path';
import { pathToFileURL } from 'node:url';
// MICA-190: one discovery, shared with `scripts/build-addons.mjs`, that strips comments
// before reading `core`. The old copy here grepped raw text, which a doc comment can fool.
import { addOnIds } from './scripts/addon-ids.js';
// MICA-205: the one derivation of "what does this code need declared", shared with
// `sdk/permissions.test.ts` and with the out-of-tree template's own copy of this build.
// It imports nothing itself, which is what lets both this config and the template's load it.
import {
  declaredPermissions,
  permissionShortfall,
  sdkImportNames,
  shortfallMessage,
  type PermissionTable
} from '../sdk/lib/permissionScan';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..');
const appsDir = path.resolve(here, 'src/apps');

const VIRTUAL = '\0addon-entry:';

/** One virtual entry per add-on: manifest + component → bootAddOn. */
function addOnEntries(): Plugin {
  return {
    name: 'mica-addon-entries',
    resolveId(id) {
      // Rolldown resolves a bare `lib.entry` value as a path relative to root before any
      // plugin sees it (`addon-entry:blabber` arrives here as `<root>/addon-entry:blabber`),
      // so match on the marker's position rather than requiring it at the start.
      const i = id.indexOf('addon-entry:');
      return i === -1 ? null : VIRTUAL + id.slice(i + 'addon-entry:'.length);
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const app = id.slice(VIRTUAL.length);
      return [
        `import '${path.resolve(here, '../sdk/app.css')}';`,
        `import manifest from '${path.join(appsDir, app, 'manifest.ts')}';`,
        `import App from '${path.join(appsDir, app, 'index.svelte')}';`,
        `import { bootAddOn } from '@mica/sdk';`,
        `void bootAddOn(manifest, App);`
      ].join('\n');
    }
  };
}

/**
 * MICA-176 deleted `facetSwap()` from here.
 *
 * It was a `resolveId` plugin, `order: 'pre'`, rewriting `inProcess/facets/<name>` to
 * `iframe/facets/<name>` — so the one specifier every `sdk/host/useXxx.ts` hook wrote
 * resolved to a shell-backed module in the phone and a sandboxed twin in an add-on, and
 * what an add-on bundle actually contained was a property of this file's regex rather than
 * of anything readable in the source. The choice now lives at the entry point:
 * `src/main.ts` imports `sdk/host/inProcess/registerFacets`, `bootAddOn` imports
 * `sdk/host/iframe/registerFacets`, and no hook names a concrete facet module. Do not
 * reintroduce a resolver plugin for this — `sdk/seam.test.ts` resolves every specifier on
 * the add-on graph to a real path and fails on anything under `sdk/host/inProcess/`.
 */

// MICA-129: matches the bare specifier and any subpath (`@mica/sdk/core/whatever`),
// so a future file added under `sdk/core.ts` doesn't reopen the confusing-error gap this
// plugin exists to close.
const CORE_ENTRY_RE = /^@mica\/sdk\/core(\/.*)?$/;

/**
 * `@mica/sdk/core` has no `resolve.alias` entry in this config, unlike the shell's own
 * `vite.config.ts` — deliberately: `useNuiBridge` is the raw transport and `boundary.test.ts`
 * already refuses it to any `core: false` app at the source level. But `tsconfig.app.json`
 * resolves the specifier fine (it has its own `paths` entry, and the package's own `exports`
 * names it), so an
 * add-on that imports it typechecks clean and only then hits Rollup's generic "could not
 * resolve" here — a confusing failure for something that is refused on purpose, not a build
 * misconfiguration. This intercepts the specifier first and fails with the actual rule
 * instead, via `this.error()` so it is still a build-time failure, not a runtime one.
 */
function refuseCoreEntry(): Plugin {
  return {
    name: 'mica-refuse-core-entry',
    resolveId: {
      order: 'pre',
      handler(id) {
        if (!CORE_ENTRY_RE.test(id)) return null;
        this.error(
          `[micaOS] an add-on may not import @mica/sdk/core — it is the raw NUI transport, ` +
            `reserved for core: true apps (boundary.test.ts already refuses this at the ` +
            `source level). Reach your own server actions through useService(id) instead.`
        );
      }
    }
  };
}

/**
 * MICA-205. A bundle may not claim less than it reaches for.
 *
 * `permissions` is self-declared, and `sdk/permissions.test.ts` only ever held *this repo's*
 * apps to it: it walks `web/src/apps/<id>`, reads what each file imports from `@mica/sdk`,
 * and fails on a manifest that declares less. An add-on built anywhere else went through no
 * such check, and the consequence is not that it gains access — the shell re-checks every
 * permission against `HOOK_OF_FACET` before answering a call — it is that the Store shows a
 * player a permission sheet that is not true, and MICA-196's re-prompt on a *widened* list
 * is only as honest as the field it compares. The player then meets the refusal as a toast
 * they cannot act on, in an app that told them it wanted nothing.
 *
 * So the same derivation runs here, over the modules that actually entered this bundle, and
 * fails the build instead of shipping the bundle.
 *
 * ## Why `transform` and not the finished chunk
 *
 * The names matter, not the text: which `@mica/sdk` exports this app imports is what
 * `PERMISSION_OF` is keyed by, and the chunk is minified by the time `generateBundle` sees
 * it — every local is renamed and the import statements are gone. `noUnsubstitutedDefines`
 * below reads the final chunk because it is looking for a literal that survives minification;
 * this is the other case, and the other case is why that one's comment says a regex over the
 * final chunk is a last resort. A `transform` hook at `order: 'pre'` sees each module's own
 * source as it enters the graph, before the Svelte compiler and before any minifier, and only
 * modules that are genuinely in the graph reach it — a file the tree-shaker dropped never
 * discloses anything, and never gets scanned.
 *
 * Attribution is by path rather than by entry chunk: a module under `src/apps/<id>/` belongs
 * to `<id>`. AGENTS.md §2.7 forbids an app importing sideways out of its own directory and
 * `sdk/boundary.test.ts` enforces it, so that is exhaustive; everything else on the graph is
 * the SDK, which discloses nothing on its own behalf.
 *
 * ## Why it counts the files it saw
 *
 * The failure mode of a scanner is silence. If the path matching broke — a rename, a
 * platform separator, a virtual id shape nobody expected — every app would come back with an
 * empty import set, every manifest would "cover" it, and this plugin would report success on
 * a bundle it never looked at. That is the shape AGENTS.md §9 names, so the count is checked:
 * the virtual entry imports each app's `manifest.ts` and `index.svelte`, so an app that
 * contributed no scanned file at all is a broken check, not a small app.
 */
function requireDeclaredPermissions(): Plugin {
  /** `@mica/sdk` names imported by each app's own files, and how many of those were seen. */
  const imported = new Map<string, Set<string>>();
  const scanned = new Map<string, number>();
  let table: PermissionTable | undefined;

  /**
   * The one table, loaded by path rather than imported by specifier — and the same way the
   * out-of-tree template has to load it, so this repo's own build exercises that route.
   *
   * A plain `import { PERMISSION_OF } from '../sdk/permissions'` reads better and does not
   * typecheck: `tsconfig.node.json` covers this config and the two files behind that import
   * — `manifest.ts` and `version.ts` — reach for `import.meta.env` and the `__MICA_*__`
   * defines, whose ambient declarations live in `sdk/env.d.ts`, which that program does not
   * include. The template has a harder version of the same problem: a Vite config is loaded
   * by **Node**, which resolves a `.ts` file but not an extensionless relative specifier
   * inside one, so an add-on author can only reach the SDK's source this way at all.
   * `sdk/lib/permissionScan.test.ts` runs a real Node against both files to keep that true.
   */
  const loadTable = async (): Promise<PermissionTable> => {
    const file = path.resolve(here, '../sdk/permissions.ts');
    const module = (await import(pathToFileURL(file).href)) as {
      PERMISSION_OF?: PermissionTable;
    };
    if (!module.PERMISSION_OF) {
      throw new Error(
        `[micaOS] ${path.relative(repoRoot, file)} did not export PERMISSION_OF. The permission ` +
          `table is what every add-on's declaration is checked against, so this refuses to ` +
          `build rather than pass every bundle by comparing against nothing.`
      );
    }
    return module.PERMISSION_OF;
  };

  /** The app a module belongs to, or `undefined` for the SDK, a dependency, a virtual id. */
  const appIdOf = (id: string): string | undefined => {
    const file = id.split('?')[0].replaceAll('\\', '/');
    const prefix = `${appsDir.replaceAll('\\', '/')}/`;
    if (!file.startsWith(prefix)) return undefined;
    return file.slice(prefix.length).split('/')[0] || undefined;
  };

  return {
    name: 'mica-addon-permissions',
    async buildStart() {
      imported.clear();
      scanned.clear();
      table = await loadTable();
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        const app = appIdOf(id);
        if (!app) return null;
        scanned.set(app, (scanned.get(app) ?? 0) + 1);
        const names = imported.get(app) ?? new Set<string>();
        for (const name of sdkImportNames(code)) names.add(name);
        imported.set(app, names);
        return null;
      }
    },
    generateBundle: {
      order: 'post',
      handler() {
        for (const app of ids) {
          if ((scanned.get(app) ?? 0) === 0) {
            this.error(
              `[micaOS] the permission scan saw no source file belonging to '${app}', so it ` +
                `checked nothing. That is this plugin being broken, not the add-on: every ` +
                `bundle's entry imports its own manifest.ts and index.svelte. Fix the path ` +
                `matching in mica-addon-permissions rather than removing this check.`
            );
          }

          const manifest = path.join(appsDir, app, 'manifest.ts');
          const declared = declaredPermissions(fs.readFileSync(manifest, 'utf8'));
          if (!declared.ok) {
            this.error(
              `[micaOS] ${path.relative(repoRoot, manifest)}: ${declared.reason} This build ` +
                `refuses to guess what an add-on discloses.`
            );
          }

          const shortfall = permissionShortfall(
            imported.get(app) ?? [],
            declared.permissions,
            table ?? {}
          );
          if (shortfall.length > 0) {
            this.error(
              `[micaOS] ${shortfallMessage(app, path.relative(repoRoot, manifest), shortfall)}`
            );
          }
        }
      }
    }
  };
}

/** Inline the single CSS asset into every entry chunk; the frame has no <link> to load it from. */
function inlineCss(): Plugin {
  return {
    name: 'mica-inline-css',
    // `order: 'post'`, not the brief's plain `generateBundle`: Vite's own CSS asset is
    // written by its internal `vite:css-post` plugin, which — regardless of where this
    // plugin sits in the `plugins` array — always runs as an actual "post"-stage hook, so
    // a normal-stage `generateBundle` here ran *before* the real `.css` entry existed in
    // `bundle` (confirmed: the inject line landed with an empty string, and a separate
    // `web.css` — Vite's default lib-mode css filename, the project's `name` in
    // `package.json` — was written alongside each bundle). Matching its own `post` stage
    // is what lets this see and remove that asset.
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const cssFiles = Object.keys(bundle).filter((f) => f.endsWith('.css'));
        const css = cssFiles
          .map((f) => (bundle[f] as { source: string | Uint8Array }).source.toString())
          .join('\n');
        for (const f of cssFiles) delete bundle[f];
        const inject = `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();\n`;
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.isEntry) chunk.code = inject + chunk.code;
        }
      }
    }
  };
}

/**
 * MICA-170. Every `__MICA_*__` identifier this tree injects has to be substituted here
 * too, and until this plugin existed nothing said so: `vite.config.ts` had a `define` block
 * and this config had none, so `__MICA_VERSION__` and `__MICA_BUILD_INFO__` survived
 * verbatim into all four shipped bundles. Inside the add-on iframe the identifiers are
 * undeclared, `sdk/version.ts`'s `typeof` guards held, and every published add-on read the
 * fallback — a plausible, confidently wrong `1.0.0`, on every server, forever.
 *
 * It failed in the direction that reads as success, and no suite saw it because no suite
 * inspects `public/addons/*.js` — the directory is gitignored and only exists after
 * `scripts/build-addons.mjs` runs. That is why the check is *here* rather than in a Vitest
 * file that greps the output directory: a test like that passes on a clean checkout by
 * finding nothing to read, which is the fail-open shape AGENTS.md §9 names. This runs
 * exactly when a bundle is produced and fails the build that would have shipped it, so
 * there is no state in which it is silent and a bad bundle exists.
 *
 * `addonDefines.test.ts` covers the other half statically — that this config defines every
 * identifier `src/vite-env.d.ts` declares — so a newly injected global is caught by the
 * unit suite before anyone gets as far as a build. It also drives this plugin's
 * `generateBundle` directly against a hand-built bundle, so the chunk/asset split below is
 * held by the suite and not only by whoever last ran a build with sourcemaps on.
 *
 * ## MICA-178: chunks only, never assets
 *
 * `generateBundle` receives rolldown's `OutputBundle` — a record of `fileName` to either an
 * `OutputChunk` (`type: 'chunk'`, JavaScript in `.code`) or an `OutputAsset`
 * (`type: 'asset'`, bytes or text in `.source`). Until MICA-178 this scanned both, and a
 * source map is an asset: `build.sourcemap: true` emits `<name>.js.map` whose
 * `sourcesContent` is every module's *pre-substitution* source, so `sdk/version.ts`'s
 * `typeof __MICA_VERSION__` read as a leak and a legitimate build failed with an error
 * indistinguishable from the real one. That is a false positive, not a weaker check: the
 * failure this guards against is an identifier the *iframe executes*, and the only thing
 * in the bundle that executes is a chunk's `.code`. Nothing in an asset — a map, an image
 * pulled in by a CSS `url()` — is evaluated by the sandbox, and the CSS itself has already
 * been inlined into the entry chunk by `inlineCss()` (also `post`, earlier in `plugins`)
 * by the time this runs, so it is scanned as chunk text.
 *
 * The narrowing is on `type`, deliberately, rather than on a `.map` filename: `type` is the
 * discriminant rolldown itself uses to say whether a file is executable output, and a
 * filename pattern would silently re-widen the moment an asset with a new extension showed
 * up. The build is left with sourcemaps off by default (unchanged); this only stops
 * `--sourcemap` from being a build-breaking flag.
 */
function noUnsubstitutedDefines(): Plugin {
  const IDENTIFIER = /__MICA_[A-Za-z0-9_]*__/g;
  return {
    name: 'mica-no-unsubstituted-defines',
    // `order: 'post'`, and last in the `plugins` array, so this sees the final chunk text —
    // including whatever `inlineCss()` (also a post hook) has prepended by then.
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        for (const [file, output] of Object.entries(bundle)) {
          if (output.type !== 'chunk') continue;
          const found = [...new Set(output.code.match(IDENTIFIER) ?? [])];
          if (found.length > 0) {
            this.error(
              `[micaOS] ${file} still contains unsubstituted build-time identifier(s): ` +
                `${found.join(', ')}. An add-on bundle runs in a sandboxed iframe where these ` +
                `are undeclared, so each one silently falls back to whatever default ` +
                `sdk/version.ts holds instead of failing. Add it to this config's ` +
                `\`define\` block — with a deliberate value for an add-on, which is not ` +
                `automatically the shell's (see the block's comment).`
            );
          }
        }
      }
    }
  };
}

/**
 * Exported for `sdk/addonDefines.test.ts`, which calls its `generateBundle` against a fake
 * bundle holding a chunk and a `.map` asset. Vite ignores named exports on a config file.
 */
export { noUnsubstitutedDefines };

// MICA-16 step 4: `output.codeSplitting: false` below is what makes each bundle
// self-contained on Vite 8's rolldown build path, and rolldown rejects more than one
// `lib.entry` once that's set ("multiple inputs are not supported when
// output.codeSplitting is false") — so a single `vite build` can't produce all four
// bundles in one pass the way the brief's rollup-era config assumed. `scripts/build-addons.mjs`
// is the fallback the brief calls for: it runs this config once per id via `ADDON_ID`,
// looping so nothing here has to hardcode the add-on list.
const ids = process.env.ADDON_ID ? [process.env.ADDON_ID] : addOnIds(appsDir);

// A bare `vite build -c vite.addon.config.ts` (no `ADDON_ID`) with more than one add-on
// discovered would otherwise reach `output.codeSplitting: false` with multiple
// `lib.entry` keys and fail with rolldown's much less legible "multiple inputs are not
// supported" error deep in the build. Failing fast here, with the actual fix named, saves
// that detour — this config is only ever meant to run through `build-addons.mjs`.
if (!process.env.ADDON_ID && ids.length > 1) {
  throw new Error(
    `[micaOS] vite.addon.config.ts needs ADDON_ID set to one of: ${ids.join(', ')} — run via scripts/build-addons.mjs, not vite build -c vite.addon.config.ts directly.`
  );
}

export default defineConfig({
  plugins: [
    addOnEntries(),
    refuseCoreEntry(),
    svelte(),
    // Its own hook orders decide when it runs, not this position: `transform` at `pre` to
    // read each module's source before the Svelte compiler, `generateBundle` at `post` to
    // judge a graph that is finished.
    requireDeclaredPermissions(),
    inlineCss(),
    // An add-on bundle inlines the SDK, so it carries micaOS's own code and the notice goes
    // with it — see the README's "If you are writing an add-on": there is no linking
    // exception, which makes this the bundle where the banner matters most.
    licenseBanner(),
    // Last, deliberately — it reads the finished chunk text. See its comment.
    noUnsubstitutedDefines()
  ],
  /**
   * MICA-170/MICA-173. Both identifiers are substituted with the **empty string**, not
   * with the shell's values, and that is the decision rather than an oversight.
   *
   * `vite.config.ts` stamps the shell with a CalVer computed from `git log`, so it moves on
   * every push to `main`. Handing that to an add-on would be worse than it looks: an add-on
   * bundle is compiled once and then loaded by whatever phone installs it, so the stamp
   * baked in here is the version of the tree that *built* the bundle, not the version of
   * the phone *running* it. For the four in-tree add-ons those coincide; for a third-party
   * add-on — the ones this whole surface exists for — they do not, and that bundle has no
   * `define` at all. A number that means one thing for our bundles and another for
   * everyone else's is not a contract.
   *
   * So an add-on is told, honestly, that it does not know: `''` — which `lib/semver.ts`
   * already reads as *not orderable* rather than folding into "up to date". The number an
   * add-on can actually act on is `SDK_CONTRACT_VERSION` (`sdk/version.ts`), which
   * moves only when the surface moves and is a plain source constant, so it needs no
   * `define` and is correct in every bundle however it was built.
   *
   * Defining them at all — rather than leaving the fallbacks in `sdk/version.ts` to produce
   * the same `''` — is what makes `noUnsubstitutedDefines()` above meaningful: a bundle
   * carrying a bare `__MICA_*__` identifier is then always a mistake, never a shrug.
   */
  define: {
    __MICA_VERSION__: JSON.stringify(''),
    __MICA_BUILD_INFO__: JSON.stringify(''),
    __MICA_BRANCH__: JSON.stringify('')
  },
  // `outDir` (`public/addons`) sits inside the shell's `publicDir` (`public/`, Vite's
  // default) so the main `vite build` can pick the bundles up through its own publicDir
  // copy — but that makes *this* config's default publicDir the same `public/` folder,
  // which Vite warned about copying into its own subdirectory (and did: `mica.svg`
  // showed up next to the bundles). This build has no use for the shell's public assets,
  // so turning its own publicDir handling off is the fix, not choosing a non-nested outDir.
  publicDir: false,
  resolve: {
    alias: [
      { find: '@mica/shared', replacement: path.resolve(here, '../shared') },
      { find: '@mica/sdk/app', replacement: path.resolve(here, '../sdk/app.ts') },
      { find: '@mica/sdk', replacement: path.resolve(here, '../sdk/addon.ts') }
      /**
       * MICA-172 deleted the `nui/fetchNui` alias that used to sit here.
       *
       * It redirected `createCrudStore`/`createPagedStore`'s transport import to the
       * `postMessage` twin. Those two factories now live in the SDK and call
       * `sdk/nui/transport`, a runtime seam that `bootAddOn` fills by importing
       * `sdk/host/iframe/fetchNui` — so an add-on bundle chooses its transport the same way
       * it chooses its facet set, at its entry point, with nothing here to keep in step. The
       * `shell/state/time` shim above is the last specifier-level swap in this file.
       */
    ],
    conditions: ['browser']
  },
  build: {
    outDir: 'public/addons',
    // `build-addons.mjs` runs this config once per id and would otherwise wipe the
    // previous iteration's bundle on every pass; it does its own single `rm -rf` up front
    // instead. Only empty here when nothing set `ADDON_ID` (a one-off manual invocation).
    emptyOutDir: !process.env.ADDON_ID,
    target: 'chrome92',
    cssCodeSplit: false,
    // Always minified, `--watch` included. The bundle text is what the shell
    // `encodeURIComponent`s into a `data:` module URL on every open, and under a parallel
    // e2e run the unminified 770 KB Blabber bundle booted slower than a 5 s assertion —
    // every Blabber test failed under load and passed alone. Read `ADDON_WATCH=1
    // pnpm build:addons` output with a source map if you need the prose. Minifying also
    // strips the doc-comment text that used to trip the `shell/state` grep.
    minify: true,
    lib: {
      entry: Object.fromEntries(ids.map((id) => [id, `addon-entry:${id}`])),
      formats: ['es'],
      fileName: (_, name) => `${name}.js`
    },
    rollupOptions: {
      treeshake: {
        // `marked` and `dompurify` are reached only through `sdk/utils.ts`'s
        // `renderMarkdown` re-export. Neither package declares `sideEffects: false`, so
        // without this every add-on carried both (~130 KB unminified) whether or not it
        // ever rendered Markdown — Snek shipped a Markdown parser. Both are pure on import.
        moduleSideEffects: (id: string) => !/node_modules\/(marked|dompurify)\//.test(id)
      },
      // Every entry is self-contained: no shared chunk, because the frame that loads one
      // bundle has no `<script>` tag or import map for another. The brief's rollup-era
      // option names (`inlineDynamicImports`, `manualChunks: () => undefined`) don't do
      // that on Vite 8's rolldown build path — `codeSplitting: false` is rolldown's own
      // option for it (one chunk per entry, nothing shared) and rejects `manualChunks`
      // outright as redundant once set, which is why that option isn't listed here too.
      output: { codeSplitting: false, preserveModules: false }
    }
  }
});
