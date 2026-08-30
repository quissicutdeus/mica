import { defineConfig, type Plugin } from 'vite';
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
        `import '${path.resolve(here, 'src/app.css')}';`,
        `import manifest from '${path.join(appsDir, app, 'manifest.ts')}';`,
        `import App from '${path.join(appsDir, app, 'index.svelte')}';`,
        `import { bootAddOn } from '@gphone/sdk';`,
        `void bootAddOn(manifest, App);`
      ].join('\n');
    }
  };
}

// `index` is excluded explicitly (`name !== 'index'` below, not just "no trailing name" as
// an earlier version of this comment claimed): `[A-Za-z]+` matches the literal word
// `index` just as readily as any real facet name, so a hypothetical `inProcess/facets/index`
// specifier would otherwise swap to a nonexistent `iframe/facets/index.ts` (iframe has no
// index — `current.ts`/`protocol.ts`'s `Facets` import is type-only and never resolved at
// this level, and nothing else spells the path with a trailing `/index`, but the guard
// costs nothing and removes the possibility outright).
const FACET_RE = /^(.*\/)?inProcess\/facets\/([A-Za-z]+)(\.svelte)?$/;

/**
 * Every `useXxx.ts` hook imports its facet by a *relative* specifier written from inside
 * `src/sdk/host/` itself — `./inProcess/facets/appRegistry`, not an absolute path
 * containing a `host/` segment. Vite's alias matcher tests the raw specifier text as
 * written, before it is resolved against the importer's directory, so a
 * `.../host/inProcess/facets/...` anchor never matches that literal string and the real
 * inProcess facet (which reaches into `shell/state/...`) would load instead of its iframe
 * twin. `FACET_RE` anchors on `inProcess/facets/<name>` instead — with an optional leading
 * path segment, so the few `../../inProcess/facets/<name>` type-position references from
 * `iframe/facets/*.ts` still match too.
 */
function facetSwap(): Plugin {
  const iframeFacets = path.resolve(here, 'src/sdk/host/iframe/facets');
  return {
    name: 'gphone-facet-swap',
    // `order: 'pre'` is load-bearing: rolldown's native resolver fast-paths plain relative
    // specifiers (`./inProcess/facets/appRegistry`, exactly what every `useXxx.ts` hook
    // writes) straight to the filesystem, bypassing a normal-stage plugin's `resolveId`
    // entirely — confirmed by adding a log here and never seeing it fire for one of these
    // while the entry's synthetic `addon-entry:` specifier (not a plain relative path) did
    // reach it. `resolve.alias` avoids this because Vite registers its alias plugin
    // `enforce: 'pre'` already; matching that here is what makes the swap actually apply.
    resolveId: {
      order: 'pre',
      handler(id) {
        const m = FACET_RE.exec(id);
        if (!m) return null;
        const [, , name, svelteExt] = m;
        if (name === 'index') return null;
        return path.join(iframeFacets, `${name}${svelteExt ?? ''}.ts`);
      }
    }
  };
}

const SHELL_TIME_RE = /(^|\/)shell\/state\/time$/;

/**
 * `src/lib/formatters.ts` — a plain formatting helper, re-exported from `@gphone/sdk`'s
 * `utils.ts` and so reachable from every add-on — imports `is24Hour` directly from
 * `shell/state/time.ts` for `formatTime`'s default. Redirects it (and anything else
 * resolving `.../shell/state/time`) to a real, tested module instead of the shell's own
 * file: `src/sdk/host/iframe/shims/time.ts`, which exposes the same live `clock` facet
 * state (`time`, `is24Hour`, `formattedTime`) via `remoteStore` — no wall-clock timer of
 * its own, just a subscription to what the shell already ticks and pushes down.
 */
function shellTimeShim(): Plugin {
  const target = path.resolve(here, 'src/sdk/host/iframe/shims/time.ts');
  return {
    name: 'gphone-shell-time-shim',
    resolveId: {
      order: 'pre',
      handler(id) {
        return SHELL_TIME_RE.test(id) ? target : null;
      }
    }
  };
}

// MICA-129: matches the bare specifier and any subpath (`@gphone/sdk/core/whatever`),
// so a future file added under `sdk/core.ts` doesn't reopen the confusing-error gap this
// plugin exists to close.
const CORE_ENTRY_RE = /^@gphone\/sdk\/core(\/.*)?$/;

/**
 * `@gphone/sdk/core` has no `resolve.alias` entry in this config, unlike the shell's own
 * `vite.config.ts` — deliberately: `useNuiBridge` is the raw transport and `boundary.test.ts`
 * already refuses it to any `core: false` app at the source level. But `tsconfig.app.json`
 * resolves the specifier fine (it maps `@gphone/sdk/*` to `src/sdk/*` for everybody), so an
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
  plugins: [addOnEntries(), facetSwap(), shellTimeShim(), refuseCoreEntry(), svelte(), inlineCss()],
  // `outDir` (`public/addons`) sits inside the shell's `publicDir` (`public/`, Vite's
  // default) so the main `vite build` can pick the bundles up through its own publicDir
  // copy — but that makes *this* config's default publicDir the same `public/` folder,
  // which Vite warned about copying into its own subdirectory (and did: `gphone.svg`
  // showed up next to the bundles). This build has no use for the shell's public assets,
  // so turning its own publicDir handling off is the fix, not choosing a non-nested outDir.
  publicDir: false,
  resolve: {
    alias: [
      { find: '@shared', replacement: path.resolve(here, '../shared') },
      { find: '@gphone/sdk/app', replacement: path.resolve(here, 'src/sdk/app.ts') },
      { find: '@gphone/sdk', replacement: path.resolve(here, 'src/sdk/addon.ts') },
      // The other swap that puts every hook on the wall side without touching a hook file.
      // The facets swap is `facetSwap()` above (a plugin, not a declarative alias) because
      // one facet needs more than a path substitution — see its doc comment.
      {
        find: /^(.*)\/nui\/fetchNui$/,
        replacement: path.resolve(here, 'src/sdk/host/iframe/fetchNui.ts')
      }
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
