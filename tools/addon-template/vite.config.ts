import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The add-on build, out of tree.
 *
 * This file is the standalone twin of gOS's own `web/vite.addon.config.ts`, and it has
 * to be a twin rather than an import: the phone's config lives in the `web` workspace,
 * which an add-on author does not have. Everything the shell relies on about a bundle is
 * decided here — one self-contained ES chunk, its CSS inlined, the Chromium 103 lowering
 * applied, the `core: true` surface refused — so a change to this file changes what your
 * bundle *is*, not merely how fast it builds.
 *
 * gOS's `web/src/lib/addonTemplate.test.ts` compares the two files knob for knob and
 * fails the phone's own build if they diverge, so the copy you are reading is checked
 * against the original rather than left to rot. That check runs in gOS's repo, though,
 * not in yours: if you edit the build options below, you are on your own.
 */

const here = import.meta.dirname;

/**
 * No alias for `@gos/sdk` — the package resolves to the right barrel on its own.
 *
 * This used to be the most important line in the file. `@gos/sdk` names two different
 * barrels: `index.ts`, which the phone's shell builds against and which reaches modules
 * expecting to run in the shell's own JavaScript context, and `addon.ts`, whose host
 * facets talk `postMessage` because an add-on runs in a sandboxed iframe. The package's
 * `exports` map used to resolve `.` to the first of those, so every project like this one
 * had to alias its way to the second, correctly, forever.
 *
 * MICA-125 pointed `.` at `addon.ts` instead. The bare specifier is target-dependent by
 * nature and the map can only be right for one audience; the audience that reads a map
 * rather than writing an alias is the one outside gOS's repo, which is you. The shell
 * aliases to its own barrel now, since it always has a Vite config to do it in.
 *
 * `requireIframeFacets()` below still checks the outcome rather than trusting it, and it
 * is worth keeping for that reason: it asserts the bundle really did get the iframe facet
 * set, whatever resolution happened to produce it.
 */
const MANIFEST = path.join(here, 'src/manifest.ts');
const COMPONENT = path.join(here, 'src/index.svelte');

/**
 * Comments out, before anything below reads a property out of the manifest.
 *
 * Not fastidiousness: the very first build of this template failed on its own sample
 * manifest, because the doc comment above `core: false` explains what `core: true` would
 * mean and a bare `/core:\s*true/` over the raw file found the prose. gOS's own
 * discovery greps unstripped manifest text and has the same hole pointing the other way —
 * a `core: true` app whose comment mentions `core: false` reads as an add-on there. This
 * strips block comments and whole-line `//` comments, which is where prose lives; a `//`
 * inside a string (a URL in `description`) truncates its own line and no other, and no
 * property below is read from a line that could contain one.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The add-on's id, read from the manifest text.
 *
 * Text, not an import: this runs while Vite is reading its config, long before anything
 * can compile a `.ts` file that imports Svelte components. gOS's own add-on discovery
 * reads the same manifests the same way, for the same reason.
 */
function readManifest(): { id: string } {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(
      `[gos-addon] no manifest at ${MANIFEST} — an add-on is a manifest and a component.`
    );
  }
  const source = withoutComments(fs.readFileSync(MANIFEST, 'utf8'));

  /**
   * The boundary, enforced where it ships.
   *
   * AGENTS.md §2.7: `core: true` means "ships with the phone and cannot be uninstalled",
   * and it is what gates `@gos/sdk/core` — the raw NUI transport. Nothing outside
   * gOS's own repo can be `core: true`: the Store installs `core: false` add-ons and
   * runs them in a sandboxed iframe. gOS enforces this with a build plugin in a config
   * you do not have and a test that scans a directory you do not have, so it is enforced
   * here instead, in the file that travels with the template.
   *
   * Refusing anything that is not literally `core: false` — rather than only refusing
   * `core: true` — is deliberate: an omitted `core` is not a licence, it is a manifest
   * `defineApp` will reject anyway, and a value this cannot read is a value it must not
   * wave through.
   */
  if (/^\s*core:\s*true\s*,?\s*$/m.test(source)) {
    throw new Error(
      `[gos-addon] ${path.relative(here, MANIFEST)} declares \`core: true\`. An add-on built ` +
        `outside gOS's own repo is always \`core: false\`: \`core: true\` means the app ships ` +
        `with the phone and cannot be uninstalled, and it is the flag that gates ` +
        `@gos/sdk/core (the raw NUI transport). The Store installs \`core: false\` bundles ` +
        `and runs them in a sandboxed iframe with no NUI at all, so a \`core: true\` bundle here ` +
        `would not gain the access it claims — it would simply be wrong about itself.`
    );
  }
  if (!/^\s*core:\s*false\s*,?\s*$/m.test(source)) {
    throw new Error(
      `[gos-addon] ${path.relative(here, MANIFEST)} does not declare \`core: false\`. It is a ` +
        `required manifest field and this build refuses to guess it.`
    );
  }

  const id = /^\s*id:\s*'([a-z][a-z0-9_]*)'/m.exec(source)?.[1];
  if (!id) {
    throw new Error(
      `[gos-addon] could not read \`id: '...'\` from ${path.relative(here, MANIFEST)}. It must be ` +
        `a single-quoted lower_snake_case literal — it is the bundle filename, the storage ` +
        `namespace, the event segment and the deep-link scheme, so it is read as text here ` +
        `rather than evaluated.`
    );
  }
  return { id };
}

const VIRTUAL = '\0gos-addon-entry';

/**
 * The entry point, synthesised rather than written into `src/`.
 *
 * It is four lines and every one of them is load-bearing in a way that is easy to get
 * subtly wrong by hand — the stylesheet import (the iframe has no `<link>` to load one
 * from), and `bootAddOn`, which installs the `postMessage` transport and the iframe facet
 * set before it mounts. Generating it keeps those out of the part of the project you edit.
 */
function addonEntry(): Plugin {
  return {
    name: 'gos-addon-entry',
    resolveId(source) {
      const i = source.indexOf('gos-addon-entry');
      return i === -1 ? null : VIRTUAL;
    },
    load(source) {
      if (source !== VIRTUAL) return null;
      return [
        `import '@gos/sdk/app.css';`,
        `import manifest from ${JSON.stringify(MANIFEST)};`,
        `import App from ${JSON.stringify(COMPONENT)};`,
        `import { bootAddOn } from '@gos/sdk';`,
        `void bootAddOn(manifest, App);`
      ].join('\n');
    }
  };
}

// Matches the bare specifier and any subpath, so a file added under the package's `core`
// entry cannot reopen the gap.
const CORE_ENTRY_RE = /^@gos\/sdk\/core(\/.*)?$/;

/**
 * `@gos/sdk/core` is refused outright.
 *
 * `useNuiBridge` is the raw NUI transport: any registered callback, by name, including the
 * ones with server-side effects. It is reserved for `core: true` apps. The package's
 * `exports` map publishes `./core` — it has to, because the phone's own core apps resolve
 * through it — so an import of it typechecks in your editor and would otherwise reach
 * Rollup and fail with a generic "could not resolve". This turns that into the actual
 * rule, at build time, with the alternative named.
 *
 * Reach your own server through `useService(id).call(...)` instead: an add-on's own
 * service actions, scoped to your app id, which is the access this boundary is drawn to
 * leave you.
 */
function refuseCoreEntry(): Plugin {
  return {
    name: 'gos-refuse-core-entry',
    resolveId: {
      order: 'pre',
      handler(source) {
        if (!CORE_ENTRY_RE.test(source)) return null;
        this.error(
          `[gos-addon] an add-on may not import @gos/sdk/core — it is the raw NUI transport, ` +
            `reserved for core: true apps that ship with the phone. A core: false bundle runs in a ` +
            `sandboxed iframe with no NUI at all, so this import cannot work at runtime even if the ` +
            `build let it through. Reach your own server actions through useService(id) instead.`
        );
      }
    }
  };
}

/**
 * The bundle must actually contain the **iframe** facet set.
 *
 * `sdk/host/iframe/registerFacets` is pulled in by `bootAddOn` and by nothing else; it is
 * what makes `useContacts()`, `useSound()` and the rest resolve to `postMessage`-backed
 * twins instead of to shell-side modules that are not there. A graph that mounts your
 * component *without* it is an add-on whose every hook throws `host facet 'x' is not
 * loaded` at whoever opens it — so this asserts the positive rather than trusting that
 * resolution went the right way.
 *
 * It matters less than it did, now that `@gos/sdk` resolves to `addon.ts` through the
 * package rather than through an alias this file had to get right. It is kept because the
 * thing it checks is the outcome, not the mechanism: a `resolve.alias` added here later, a
 * dependency override, or a future change to the package's `exports` map would all show up
 * as the same failure.
 *
 * Note what it deliberately does **not** ban: `sdk/host/inProcess/createInProcessHost` and
 * `sdk/host/inProcess/system` are legitimately on the add-on graph. They are shell-free,
 * and `bootAddOn` builds its own host out of the first. Banning the directory by name is
 * the shape-matching mistake gOS's `sdk/seam.test.ts` documents at length; the
 * classification is by what a module imports, not by where it sits.
 */
function requireIframeFacets(): Plugin {
  let seen = false;
  return {
    name: 'gos-addon-require-iframe-facets',
    buildStart() {
      seen = false;
    },
    transform(_code, id) {
      if (id.replace(/\\/g, '/').endsWith('/sdk/host/iframe/registerFacets.ts')) seen = true;
      return null;
    },
    generateBundle: {
      order: 'post',
      handler() {
        if (!seen) {
          this.error(
            `[gos-addon] this bundle does not contain the SDK's iframe facet set ` +
              `(sdk/host/iframe/registerFacets). An add-on that boots without it mounts fine ` +
              `and then throws "host facet 'x' is not loaded" on the first hook it uses. The ` +
              `usual cause is \`@gos/sdk\` having resolved to the package's \`index.ts\` ` +
              `(the shell barrel) rather than \`addon.ts\` — check for a \`resolve.alias\` ` +
              `or a dependency override redirecting it.`
          );
        }
      }
    }
  };
}

/** One capability your code reaches for, and the `@gos/sdk` import that discloses it. */
interface PermissionShortfall {
  hook: string;
  permission: string;
}

/**
 * The part of gOS's `sdk/lib/permissionScan.ts` this build uses, plus the table it needs.
 *
 * Described here rather than imported as types: the SDK publishes no subpath for its build
 * helpers, so these files are reached by path (below) and TypeScript has nothing to follow.
 * Nothing rests on this description being right — the values are the SDK's own, and
 * `loadPermissionScan` refuses to continue if any of them is missing.
 */
interface SdkPermissionScan {
  table: Record<string, string | readonly string[] | null>;
  sdkImportNames: (source: string) => string[];
  declaredPermissions: (
    manifestSource: string
  ) => { ok: true; permissions: string[] } | { ok: false; reason: string };
  permissionShortfall: (
    imported: Iterable<string>,
    declared: Iterable<string>,
    table: Record<string, string | readonly string[] | null>
  ) => PermissionShortfall[];
  shortfallMessage: (
    appId: string,
    manifestPath: string,
    shortfall: readonly PermissionShortfall[]
  ) => string;
}

/**
 * gOS's own permission derivation, loaded out of the `@gos/sdk` you installed.
 *
 * The package is located through the one specifier it publishes, so this holds wherever your
 * package manager put it. Everything below that point is a plain file read of a package that
 * is consumed as source anyway — the same `.ts` files Vite is about to compile into your
 * bundle — and is loaded with `import()` of a `file://` URL because Node, which reads this
 * config, resolves a `.ts` file but not a bare deep specifier the SDK does not publish.
 *
 * Every failure here throws. There is no path through this function that returns a scanner
 * which checks nothing.
 */
async function loadPermissionScan(): Promise<SdkPermissionScan> {
  // `await` because Vite substitutes its own `import.meta.resolve` in a config file; Node's
  // returns a string, and awaiting one costs nothing either way.
  const entry = await Promise.resolve(import.meta.resolve('@gos/sdk'));
  const sdkRoot = path.dirname(fileURLToPath(entry));

  const load = async (relative: string): Promise<Record<string, unknown>> => {
    const file = path.join(sdkRoot, relative);
    if (!fs.existsSync(file)) {
      throw new Error(
        `[gos-addon] cannot check this add-on's permissions: ${file} is not there. That ` +
          `file is part of @gos/sdk and this build reads it to learn which imports need ` +
          `which permission. If your SDK is newer than this template, the file has moved — ` +
          `take the current template rather than deleting the check, which would let a ` +
          `manifest understate what your add-on does with nothing to notice.`
      );
    }
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  };

  const table = (await load('permissions.ts')).PERMISSION_OF as SdkPermissionScan['table'];
  if (!table || Object.keys(table).length === 0) {
    throw new Error(
      `[gos-addon] @gos/sdk's permission table came back empty. Comparing against it ` +
        `would pass every manifest, so this build stops instead.`
    );
  }

  const scan = await load('lib/permissionScan.ts');
  const required = [
    'sdkImportNames',
    'declaredPermissions',
    'permissionShortfall',
    'shortfallMessage'
  ];
  for (const name of required) {
    if (typeof scan[name] !== 'function') {
      throw new Error(
        `[gos-addon] @gos/sdk's lib/permissionScan.ts does not export ${name}. This ` +
          `template is out of step with the SDK you installed; take the current one.`
      );
    }
  }

  return {
    table,
    sdkImportNames: scan.sdkImportNames as SdkPermissionScan['sdkImportNames'],
    declaredPermissions: scan.declaredPermissions as SdkPermissionScan['declaredPermissions'],
    permissionShortfall: scan.permissionShortfall as SdkPermissionScan['permissionShortfall'],
    shortfallMessage: scan.shortfallMessage as SdkPermissionScan['shortfallMessage']
  };
}

/**
 * Your manifest must not claim less than your code reaches for.
 *
 * `permissions` is what the Store shows a player before they install your add-on, and gOS
 * asks them again when an update *widens* it. Declaring less than you use does not buy you
 * anything — the shell re-checks every permission against its own table before answering a
 * call, so an undeclared hook throws either way — it makes that disclosure untrue, and the
 * player meets the refusal as a toast in an app that told them it wanted nothing.
 *
 * gOS's own add-on build runs this same check (MICA-205), and its test suite runs it
 * over every app in that repo. Neither of those can see your bundle, so it runs here too.
 * Declaring *more* than you use is fine, always — this only ever fails on less.
 *
 * ## Where the answer comes from
 *
 * The mapping from an `@gos/sdk` import to the permission it discloses is the SDK's, not
 * this file's: a copy of it here would be wrong the first time gOS adds a hook. So the two
 * source files behind it are loaded out of the installed `@gos/sdk` at build time —
 * `permissions.ts` for the table and `lib/permissionScan.ts` for the derivation, which is the
 * very code gOS's own build and test suite use.
 *
 * They are loaded **by path**, and by dynamic `import()` of a `file://` URL, because a Vite
 * config is read by Node rather than by Vite's own pipeline: every bare specifier in it is
 * handed to Node, and Node loads a `.ts` file but will not resolve an extensionless relative
 * specifier inside one. Both files are written with no relative import at all so that this
 * works, and gOS's `sdk/lib/permissionScan.test.ts` starts a real Node and imports each of
 * them, so the day that stops being true it fails there rather than here.
 *
 * If gOS ever moves either file, this build stops with the path it looked for. That is the
 * intended failure: a permission check that quietly does nothing is worse than none, because
 * a green build reads as a checked one.
 */
function requireDeclaredPermissions(): Plugin {
  /** Every name your source imports from `@gos/sdk`, and how many files were scanned. */
  const imported = new Set<string>();
  let scanned = 0;
  let sdk: SdkPermissionScan | undefined;

  /** Yours, as opposed to the SDK's or a dependency's: a real file under this project. */
  const isYours = (id: string): boolean => {
    const file = id.split('?')[0].replaceAll('\\', '/');
    const root = here.replaceAll('\\', '/');
    return file.startsWith(`${root}/`) && !file.includes('/node_modules/');
  };

  return {
    name: 'gos-addon-permissions',
    async buildStart() {
      imported.clear();
      scanned = 0;
      sdk = await loadPermissionScan();
    },
    transform: {
      // `pre`, so this reads each file's own source before the Svelte compiler rewrites it
      // and long before anything is minified. What it needs is the *names* you imported, and
      // by the time a bundle exists those are gone.
      order: 'pre',
      handler(code, id) {
        if (!isYours(id)) return null;
        scanned++;
        for (const name of sdk?.sdkImportNames(code) ?? []) imported.add(name);
        return null;
      }
    },
    generateBundle: {
      order: 'post',
      handler() {
        if (!sdk) {
          this.error(`[gos-addon] the permission scan did not load. This is a bug.`);
        }
        if (scanned === 0) {
          // The failure mode of a scanner is silence: if nothing matched, every manifest
          // "covers" an empty import list and this reports success on a bundle it never
          // looked at. Your entry imports src/manifest.ts and src/index.svelte, so zero
          // files means the matching is broken, not that your app is small.
          this.error(
            `[gos-addon] the permission scan saw none of your source files, so it checked ` +
              `nothing. Refusing to report a pass it did not earn.`
          );
        }

        const declared = sdk.declaredPermissions(fs.readFileSync(MANIFEST, 'utf8'));
        if (!declared.ok) {
          this.error(
            `[gos-addon] ${path.relative(here, MANIFEST)}: ${declared.reason} This build ` +
              `refuses to guess what your add-on discloses.`
          );
        }

        const shortfall = sdk.permissionShortfall(imported, declared.permissions, sdk.table);
        if (shortfall.length > 0) {
          this.error(
            `[gos-addon] ${sdk.shortfallMessage(id, path.relative(here, MANIFEST), shortfall)}`
          );
        }
      }
    }
  };
}

/**
 * Inline the CSS into the entry chunk.
 *
 * The Store hands the bundle to a sandboxed iframe as a `data:` module URL. There is no
 * document to put a `<link>` in and no server to fetch a sibling `.css` from, so a
 * stylesheet emitted as a separate asset is a stylesheet that never loads.
 *
 * `order: 'post'` because Vite's own `vite:css-post` plugin writes that asset in the post
 * stage; a normal-stage hook here runs before it exists and silently inlines an empty
 * string.
 */
function inlineCss(): Plugin {
  return {
    name: 'gos-addon-inline-css',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
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
 * No `__GOS_*__` identifier may survive into the output.
 *
 * `sdk/version.ts` reads two build-time globals behind `typeof` guards. Inside the add-on
 * iframe an unsubstituted identifier is simply undeclared, the guard holds, and the
 * fallback fires — so a missing `define` does not throw, it produces a bundle that is
 * confidently wrong about what it is running on. gOS shipped exactly that for a while
 * (MICA-170). This fails the build instead.
 *
 * If a future SDK adds an identifier this does not know about, the fix is to add it to
 * `define` below with a value that is honest for an add-on — which is not automatically
 * the phone's, see that block.
 */
function noUnsubstitutedDefines(): Plugin {
  const IDENTIFIER = /__GOS_[A-Za-z0-9_]*__/g;
  return {
    name: 'gos-addon-no-unsubstituted-defines',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const [file, chunk] of Object.entries(bundle)) {
          const text =
            chunk.type === 'chunk'
              ? chunk.code
              : typeof chunk.source === 'string'
                ? chunk.source
                : new TextDecoder().decode(chunk.source);
          const found = [...new Set(text.match(IDENTIFIER) ?? [])];
          if (found.length > 0) {
            this.error(
              `[gos-addon] ${file} still contains unsubstituted build-time identifier(s): ` +
                `${found.join(', ')}. Inside the add-on iframe these are undeclared, so each one ` +
                `silently falls back to whatever default the SDK holds instead of failing. Add it ` +
                `to this config's \`define\` block with a value that is true for an add-on.`
            );
          }
        }
      }
    }
  };
}

const { id } = readManifest();

export default defineConfig({
  plugins: [
    addonEntry(),
    refuseCoreEntry(),
    svelte(),
    requireIframeFacets(),
    // Its hook orders place it, not this line: `transform` at `pre` to read your source
    // before the Svelte compiler, `generateBundle` at `post` to judge a finished graph.
    requireDeclaredPermissions(),
    inlineCss(),
    // Last, deliberately — it reads the finished chunk text, including what `inlineCss()`
    // has prepended by then.
    noUnsubstitutedDefines()
  ],
  /**
   * Both identifiers are the **empty string**, and that is the honest value rather than an
   * oversight.
   *
   * `__GOS_VERSION__` is the running phone's CalVer build stamp. Your bundle is compiled
   * once and then loaded by whatever phone installs it, so at build time it genuinely does
   * not know. `''` is the encoding the SDK already gives to "not a version" — its
   * `lib/semver.ts` reads it as *not orderable* rather than folding it into "up to date" —
   * and `GOS_VERSION` is documented to be checked for truthiness before use.
   *
   * The number you *can* act on is `SDK_CONTRACT_VERSION`, a plain source constant in the
   * SDK that needs no `define` and is correct in every bundle however it was built.
   */
  define: {
    __GOS_VERSION__: JSON.stringify(''),
    __GOS_BUILD_INFO__: JSON.stringify(''),
    __GOS_BRANCH__: JSON.stringify('')
  },
  publicDir: false,
  resolve: {
    // No `@gos/sdk` alias: the package's own `exports` map resolves it to `addon.ts`.
    // See the note at the top of this file for why that was not always true.
    conditions: ['browser']
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /**
     * FiveM's release CEF is Chromium 103 (AGENTS.md §6). `chrome92` is the floor gOS's
     * own add-on build targets, deliberately below 103 rather than at it. Raising this
     * produces a bundle that runs in your browser and throws in game, and nothing in any
     * test suite — yours or gOS's — can catch that.
     */
    target: 'chrome92',
    cssCodeSplit: false,
    /**
     * Always minified, and not only for size. The shell `encodeURIComponent`s this file
     * into a `data:` module URL on every open of your app; an unminified bundle is
     * measurably slower to boot.
     */
    minify: true,
    lib: {
      entry: { [id]: 'gos-addon-entry' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`
    },
    rollupOptions: {
      treeshake: {
        /**
         * `marked` and `dompurify` reach an add-on only through the SDK's `renderMarkdown`
         * re-export. Neither declares `sideEffects: false`, so without this every add-on
         * carries a Markdown parser and a sanitiser whether or not it renders Markdown.
         * Both are pure on import.
         */
        moduleSideEffects: (moduleId: string) =>
          !/node_modules\/(marked|dompurify)\//.test(moduleId)
      },
      /**
       * One chunk, nothing shared. The iframe that loads this bundle has no `<script>` tag
       * and no import map for a second file, so a shared vendor chunk is a chunk that can
       * never be fetched. `codeSplitting: false` is rolldown's own option for it; the
       * rollup-era `inlineDynamicImports` / `manualChunks` do not do this on Vite 8.
       */
      output: { codeSplitting: false, preserveModules: false }
    }
  }
});
