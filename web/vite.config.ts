/// <reference types="vitest" />
import { licenseBanner } from '../scripts/license-banner.js';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import path from 'path';
import { execSync } from 'child_process';

function getGitInfo() {
  const envBranch = process.env.GITHUB_REF_NAME;
  const envCommit = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.substring(0, 7) : null;

  if (envBranch && envCommit) {
    return { commit: envCommit, branch: envBranch };
  }

  try {
    const commit = execSync('git rev-parse --short HEAD').toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    return { commit, branch };
  } catch {
    return { commit: 'dev', branch: 'main' };
  }
}

/**
 * The subsets of a webfont this phone actually renders.
 *
 * `@fontsource/roboto`'s per-weight stylesheet declares nine `@font-face` blocks —
 * cyrillic, cyrillic-ext, greek, greek-ext, math, symbols, vietnamese, latin-ext and
 * latin — and four of those weights are imported in `main.ts`, so the untrimmed build
 * emits 72 font files and 895KB. `math` and `symbols` alone are most of it.
 *
 * Note what this deliberately does NOT do: import the package's per-subset entrypoints
 * (`@fontsource/roboto/latin-400.css`) instead. Those ship the same `@font-face` with
 * its `unicode-range` line REMOVED, because each is meant to be the only face for its
 * family/weight. Import two of them and you have declared two faces with identical
 * family, style and weight and no ranges to separate them — by CSS Fonts §5.2 the last
 * declaration wins for the whole family, and a glyph missing from it falls out of the
 * family to the next entry in the `font-family` stack rather than across to its sibling
 * face. Importing `latin-ext` second would therefore render ordinary ASCII body text in
 * whatever CEF picks as a fallback, everywhere, silently.
 *
 * Filtering the full stylesheet keeps every `unicode-range` intact, which is what makes
 * more than one subset safe to ship at all.
 *
 * Adding a subset back is one entry here. A player whose name uses a glyph outside these
 * still reads it — the browser falls back to a system font for that run of characters —
 * so this is a typeface question, not a mojibake one, and it is independent of the
 * database being utf8mb4.
 */
const FONT_SUBSETS = ['latin', 'latin-ext'];

/**
 * Drop the font subsets this phone does not render, and the legacy `.woff` fallback.
 *
 * Both halves are byte-for-byte invisible in the product: Vite emits a font file only
 * because some `url()` names it, so deleting the reference is what deletes the file.
 *
 *   72 files / 895KB  ->  16 files / 289KB   (subsets)
 *                     ->   8 files / 149KB   (dropping .woff)
 *
 * The `.woff` fallback goes because `build.target` here is `chrome103` and woff2 has been
 * supported since Chrome 36 — in FiveM the runtime is CEF, which is Chromium, and in the
 * browser demo it is whatever the visitor has. Neither can reach the fallback, so it is
 * ~140KB that exists only to be ignored.
 *
 * `enforce: 'pre'` is load-bearing rather than tidiness: Vite's own `vite:css` plugin
 * resolves each `url()` and registers the file for emission during ITS transform. A
 * normal-stage plugin runs after that, so the references would already have been turned
 * into emitted assets and pruning the text here would leave the files in `dist/` with
 * nothing pointing at them.
 */
function trimFonts(subsets: string[] = FONT_SUBSETS): Plugin {
  // Every filename in this package is `roboto-<subset>-<weight>-<style>.woff2`, and the
  // subset itself contains hyphens (`latin-ext`, `cyrillic-ext`), so the weight is the
  // anchor: it is the only all-digits segment.
  const FACE = /\/\*[^*]*\*\/\s*@font-face\s*\{[^}]*\}/g;
  const SUBSET_OF = /roboto-(.+)-\d+-(?:normal|italic)\.woff2/;

  return {
    name: 'mica:trim-fonts',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;

      let kept = 0;
      const out = code.replace(FACE, (face: string) => {
        const subset = face.match(SUBSET_OF)?.[1];
        if (subset === undefined || !subsets.includes(subset)) return '';
        kept++;
        // `url(a.woff2) format('woff2'), url(a.woff) format('woff')` -> just the woff2.
        return face.replace(/,\s*url\([^)]*\.woff\)\s*format\((['"])woff\1\)/g, '');
      });

      // A silent zero here would ship a phone with no webfont at all, looking merely a
      // little off rather than broken, so it fails the build instead. The way this
      // breaks is an upstream change to the filename convention the regex above reads.
      if (kept === 0) {
        this.error(
          `mica:trim-fonts matched no @font-face in ${id} for subsets [${subsets.join(', ')}]. ` +
            `If @fontsource changed its filename convention, SUBSET_OF needs updating.`
        );
      }
      return { code: out, map: null };
    }
  };
}

// CalVer, "YYYY.MM.DD.N" (N = commit's position among same-day commits).
// Docker excludes .git from the build context, so `deploy` passes this
// precomputed via MICA_CALVER; falls back to git log for local builds.
function getCalVer() {
  if (process.env.MICA_CALVER) return process.env.MICA_CALVER;
  try {
    const dates = execSync("git log --format=%cd --date=format:'%Y.%m.%d'")
      .toString()
      .trim()
      .split('\n');
    const date = dates[0];
    const count = dates.filter((d) => d === date).length;
    return `${date}.${count}`;
  } catch {
    return '0.0.0.0';
  }
}

/**
 * `renderMarkdown` and the two libraries behind it, which load only with code that renders
 * markdown (MICA-449).
 *
 * They used to ride in the modulepreloaded `vendor` chunk, evaluated at every boot, and
 * nothing at boot calls them. The one caller in this build is a dead copy of Notes: an
 * add-on, run from its own bundle in a frame, but `shell/state/registry.ts` lazily globs
 * every app's `index.svelte` and `tablet.svelte`, so its chunks are emitted anyway.
 *
 * Two settings, and each is useless without the other:
 *
 * - **A `markdown` chunk of their own**, so they leave `vendor` and load as a static import
 *   of whichever lazy chunk calls `renderMarkdown` — a core app that starts rendering
 *   markdown gets them when it opens, still not at boot.
 * - **No module side effects.** Neither package declares `sideEffects: false`, and the
 *   barrel re-exports `renderMarkdown` statically, so without this the entry kept a bare
 *   `import "./markdown-*.js"` for ordering and the chunk was modulepreloaded at startup
 *   all the same. All three modules are pure on import.
 *
 * `vite.addon.config.ts` and the add-on template carry the library half of the rule: an
 * add-on is one inlined chunk, so there is no chunk to place `markdown.ts` in.
 * `scripts/check-markdown-chunks.js` reads the build for what this is meant to produce.
 */
const MARKDOWN_MODULES = /node_modules\/(marked|dompurify)\/|\/sdk\/lib\/markdown\.ts$/;

const gitInfo = getGitInfo();
const version = getCalVer();
const buildInfo = `v${version} (${gitInfo.branch}@${gitInfo.commit})`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [trimFonts(), svelte(), licenseBanner()],
  base: './',
  define: {
    __MICA_VERSION__: JSON.stringify(version),
    __MICA_BUILD_INFO__: JSON.stringify(buildInfo),
    // MICA-192: the branch on its own, for the §13 source address. `buildInfo` above
    // already contains it, welded into a string meant for a human to read.
    __MICA_BRANCH__: JSON.stringify(gitInfo.branch)
  },
  resolve: {
    alias: {
      '@mica/shared': path.resolve(import.meta.dirname, '../shared'),
      // Before the bare `@mica/sdk` entry, and it has to stay there: aliases are tried
      // in order, and the shorter key matches this specifier as a prefix — resolving it
      // to `../sdk/index.ts/testing`, which is not a path.
      '@mica/sdk/testing': path.resolve(import.meta.dirname, './src/testing.ts'),
      // The leaf a manifest imports. Same ordering rule as above, and the reason it exists
      // is in `../sdk/app.ts`: a manifest that imports the full barrel closes a cycle,
      // because the barrel reaches the registry and the registry globs every manifest.
      '@mica/sdk/app': path.resolve(import.meta.dirname, '../sdk/app.ts'),
      // Core-only surface. Same ordering rule as `/testing` above.
      '@mica/sdk/core': path.resolve(import.meta.dirname, '../sdk/core.ts'),
      '@mica/sdk': path.resolve(import.meta.dirname, '../sdk/index.ts')
    },
    conditions: ['browser']
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'chrome103',
    cssTarget: 'chrome103',
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;
        warn(warning);
      },
      // MICA-449: pure on import, so the barrel's static re-export does not pin them to
      // startup. `MARKDOWN_MODULES` above has the rest.
      treeshake: {
        moduleSideEffects: (id: string) => !MARKDOWN_MODULES.test(id)
      },
      output: {
        manualChunks(id) {
          if (MARKDOWN_MODULES.test(id)) return 'markdown';
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
      }
    }
  },
  // Pinned rather than left to resolve 'localhost': in the CI container, Node's fetch
  // and Vite's own bind can pick different address families for that name, so the dev
  // server comes up but `scripts/verify.js`'s readiness probe (and Playwright's
  // `webServer.url`) connects to the wrong one and times out. 127.0.0.1 everywhere
  // removes the ambiguity.
  server: {
    host: '127.0.0.1'
  },
  test: {
    globals: true,
    // MICA-32: `node`, not `jsdom`, is the *default* — jsdom's setup/teardown cost is
    // real (profiled at ~600ms/file) and most test files here never touch the DOM at all.
    // A file that renders a component, touches `document`/`window`, or imports something
    // that does (`registry.ts`'s eager manifest glob counts — see below) opts back into a
    // real DOM with a `// @vitest-environment jsdom` docblock as its first line. Getting
    // this wrong is loud and immediate (`ReferenceError: document is not defined`), not
    // silent — unlike swapping the DOM implementation itself, which was tried and reverted
    // (`docs/dev-loop.md`) because it broke DOMPurify's sanitization without any test
    // noticing on its own.
    environment: 'node',
    // Gives jsdom's `crypto` the `subtle` member it lacks, which `pool: 'vmThreads'` below
    // exposes; the file says why it is safe.
    setupFiles: ['./src/test/setup.ts'],
    // MICA-172: `../sdk/**` mirrors the `../shared/**` entry beside it. The SDK is its
    // own workspace package now, but it deliberately does NOT get a third Vitest project:
    // that would mean a second copy of the Svelte plugin, the jsdom opt-in convention, the
    // `@mica/shared` alias and the `@material/material-color-utilities` inline workaround — and
    // four copies of a convention is how two of them end up disagreeing. Reaching across a
    // package boundary in this include is the established precedent, not a new one.
    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      '../shared/**/*.test.ts',
      '../sdk/**/*.test.ts'
    ],
    /**
     * Parallel again, and this is the single biggest cost in the local loop: the suite
     * runs in ~12s against ~70s serialized.
     *
     * It was turned off for a real race. `registry.ts` eagerly globs every app manifest,
     * which transitively pulls in the whole `sdk/components.ts` barrel, and one test
     * file's jsdom environment could tear down while that module graph was still
     * resolving for another file in the same worker — an EnvironmentTeardownError that
     * Vitest counts as a failure even though every assertion passed (MICA-32).
     *
     * It does not reproduce on Vitest 4.1.11: five consecutive full runs, 127 files and
     * 1063 tests, no teardown error and no unhandled rejection. Five runs is not a proof
     * about a race, so what to do if it returns is written down rather than rediscovered:
     * the failure is loud and names EnvironmentTeardownError, and the narrow fix is to
     * split the ~69 `@vitest-environment jsdom` files into their own Vitest project with
     * `fileParallelism: false` — the other ~57 are node-environment and were never
     * exposed to it. Setting this back to `false` wholesale is the blunt version and
     * costs the other minute.
     */
    fileParallelism: true,
    /**
     * Each file runs in a fresh VM context inside a long-lived worker thread, instead of
     * a fresh child process per file. Isolation per file is kept; what goes is paying for a
     * new Node process and a cold module graph every time — `environment` was 44% of the
     * forks run's Duration and is 7-11% of this one's.
     *
     * Measured on the 16-core dev box, all 305 files / 3792 tests, sibling work running so
     * wall time is noisy (the forks run measured anywhere from 35s to 86s):
     *
     *                          wall         CPU-s (user+sys)   peak RSS
     *   forks (the default)    35.6s        487                ~3.1GB (15 processes)
     *   vmThreads, no limit    18.0s        198                 7.6GB (one process)
     *   vmThreads, 512MB       16.3-22.8s   197-207             4.6-6.6GB
     *
     * and with `--maxWorkers=3`, the shape of a 4-core CI runner: forks 87s at ~750MB;
     * vmThreads unbounded 23-42s at 3.6-3.8GB; vmThreads at 512MB 27-29s at 2.0GB.
     *
     * The memory is the cost, and `vmMemoryLimit` is what bounds it. A VM context is never
     * collected once a file has run in it, so a worker accumulates every file it has run
     * until its heap reaches the limit and it is recycled — and the default limit is
     * 1/maxWorkers of the machine's memory, i.e. the workers together may grow to all of
     * it, on a CI runner that also hosts game servers. With fifteen workers each runs ~20
     * files and the limit barely bites; with three each runs ~100, and it halves the peak.
     * 512MB costs nothing measurable against the noise above.
     *
     * The price is realm boundaries. A jsdom file's `globalThis` IS jsdom's window, while
     * some globals Vitest lends it (`structuredClone`, `setImmediate`'s queue as jsdom's own
     * module sees it) are Node's — so a Map out of `structuredClone` is another realm's Map,
     * and jsdom's `crypto` has no `subtle`. `src/test/setup.ts` covers the second;
     * `IframeHostServer.test.ts` and `nui/transport.test.ts` say how they handle the first.
     * A new failure that only appears under this pool and names a prototype, `instanceof`,
     * a missing global or a fake timer that never fires is that boundary, not flake:
     * `--pool=forks` on the one file confirms it.
     */
    pool: 'vmThreads',
    vmMemoryLimit: '512MB',
    /**
     * Four times the default 5s. The timeout is a guard against a hung test, not a
     * budget for a fast one, and the default was sized for neither: nine suites here
     * call `vi.resetModules()` and re-import their module under test per case, so each
     * case pays a fresh resolve of that module graph while every other worker is doing
     * the same. On a 4-core CI runner with two game servers beside it, four of those
     * cases crossed 5s with every assertion still to pass. A hang still fails, 15s later.
     */
    testTimeout: 20_000,
    /**
     * The same figure for hooks, which default to 10s and are not covered by `testTimeout`.
     * `beforeEach(async () => { vi.resetModules(); await import(...) })` is the cold re-import
     * above moved into a hook (nui/mocks/glimpse.test.ts, spark.test.ts), and on the slow
     * Forgejo runner it crossed 10s with every assertion still to run.
     */
    hookTimeout: 20_000,
    server: {
      deps: {
        // `@material/material-color-utilities@0.4.0` ships extensionless relative
        // imports inside its own ESM (`from '../dynaminccolor/dynamic_color'`, no
        // `.js`). Node's ESM resolver requires the extension and throws
        // ERR_MODULE_NOT_FOUND on import; Vite's resolver fills it in from
        // `resolve.extensions`. Inlining routes the package through Vite in tests, so
        // the suite resolves it the same way the browser build already does. Not a
        // workaround for our code — the published package is malformed.
        inline: ['@material/material-color-utilities']
      }
    }
  }
});
