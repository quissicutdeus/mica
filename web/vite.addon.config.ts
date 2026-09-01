import { defineConfig, type Plugin } from 'vite';
import { licenseBanner } from '../scripts/license-banner.js';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import fs from 'fs';

const here = import.meta.dirname;
const appsDir = path.resolve(here, 'src/apps');

// Duplicated in `scripts/build-addons.mjs` rather than imported from one shared module:
// tried factoring this into `scripts/addonIds.mjs` and importing it here, but
// `tsc -p tsconfig.node.json` (run by `pnpm check`) rejected it —
// `TS7016: Could not find a declaration file for module './scripts/addonIds.mjs'` — since
// this config has no `allowJs`/`.d.ts` for plain JS modules, and adding either is a bigger
// change than this dedupe is worth. If the two ever drift, fix it by adding proper JS
// module type support then, not by hardcoding a list here.
/** Every app whose manifest says `core: false` — the same text read `permissions.test.ts` does. */
function addOnIds(): string[] {
  return fs.readdirSync(appsDir).filter((id) => {
    const file = path.join(appsDir, id, 'manifest.ts');
    return fs.existsSync(file) && /core:\s*false/.test(fs.readFileSync(file, 'utf8'));
  });
}

const VIRTUAL = '\0addon-entry:';

/** One virtual entry per add-on: manifest + component → bootAddOn. */
function addOnEntries(): Plugin {
  return {
    name: 'gphone-addon-entries',
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
        `import { bootAddOn } from '@gphone/sdk';`,
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

// MICA-129: matches the bare specifier and any subpath (`@gphone/sdk/core/whatever`),
// so a future file added under `sdk/core.ts` doesn't reopen the confusing-error gap this
// plugin exists to close.
const CORE_ENTRY_RE = /^@gphone\/sdk\/core(\/.*)?$/;

/**
 * `@gphone/sdk/core` has no `resolve.alias` entry in this config, unlike the shell's own
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
    name: 'gphone-refuse-core-entry',
    resolveId: {
      order: 'pre',
      handler(id) {
        if (!CORE_ENTRY_RE.test(id)) return null;
        this.error(
          `[gPhone] an add-on may not import @gphone/sdk/core — it is the raw NUI transport, ` +
            `reserved for core: true apps (boundary.test.ts already refuses this at the ` +
            `source level). Reach your own server actions through useService(id) instead.`
        );
      }
    }
  };
}

/** Inline the single CSS asset into every entry chunk; the frame has no <link> to load it from. */
function inlineCss(): Plugin {
  return {
    name: 'gphone-inline-css',
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
 * unit suite before anyone gets as far as a build.
 */
function noUnsubstitutedDefines(): Plugin {
  const IDENTIFIER = /__MICA_[A-Za-z0-9_]*__/g;
  return {
    name: 'gphone-no-unsubstituted-defines',
    // `order: 'post'`, and last in the `plugins` array, so this sees the final chunk text —
    // including whatever `inlineCss()` (also a post hook) has prepended by then.
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        for (const [file, chunk] of Object.entries(bundle)) {
          // Assets are decoded rather than `.toString()`-ed: a `Uint8Array`'s own
          // `toString` yields `"104,101,..."`, in which nothing ever matches and every
          // binary asset would silently read as clean.
          const text =
            chunk.type === 'chunk'
              ? chunk.code
              : typeof chunk.source === 'string'
                ? chunk.source
                : new TextDecoder().decode(chunk.source);
          const found = [...new Set(text.match(IDENTIFIER) ?? [])];
          if (found.length > 0) {
            this.error(
              `[gPhone] ${file} still contains unsubstituted build-time identifier(s): ` +
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

// MICA-16 step 4: `output.codeSplitting: false` below is what makes each bundle
// self-contained on Vite 8's rolldown build path, and rolldown rejects more than one
// `lib.entry` once that's set ("multiple inputs are not supported when
// output.codeSplitting is false") — so a single `vite build` can't produce all four
// bundles in one pass the way the brief's rollup-era config assumed. `scripts/build-addons.mjs`
// is the fallback the brief calls for: it runs this config once per id via `ADDON_ID`,
// looping so nothing here has to hardcode the add-on list.
const ids = process.env.ADDON_ID ? [process.env.ADDON_ID] : addOnIds();

// A bare `vite build -c vite.addon.config.ts` (no `ADDON_ID`) with more than one add-on
// discovered would otherwise reach `output.codeSplitting: false` with multiple
// `lib.entry` keys and fail with rolldown's much less legible "multiple inputs are not
// supported" error deep in the build. Failing fast here, with the actual fix named, saves
// that detour — this config is only ever meant to run through `build-addons.mjs`.
if (!process.env.ADDON_ID && ids.length > 1) {
  throw new Error(
    `[gPhone] vite.addon.config.ts needs ADDON_ID set to one of: ${ids.join(', ')} — run via scripts/build-addons.mjs, not vite build -c vite.addon.config.ts directly.`
  );
}

export default defineConfig({
  plugins: [
    addOnEntries(),
    refuseCoreEntry(),
    svelte(),
    inlineCss(),
    // An add-on bundle inlines the SDK, so it carries gPhone's own code and the notice goes
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
  // which Vite warned about copying into its own subdirectory (and did: `gphone.svg`
  // showed up next to the bundles). This build has no use for the shell's public assets,
  // so turning its own publicDir handling off is the fix, not choosing a non-nested outDir.
  publicDir: false,
  resolve: {
    alias: [
      { find: '@gphone/shared', replacement: path.resolve(here, '../shared') },
      { find: '@gphone/sdk/app', replacement: path.resolve(here, '../sdk/app.ts') },
      { find: '@gphone/sdk', replacement: path.resolve(here, '../sdk/addon.ts') }
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
