import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';

/**
 * A real add-on, built the way an author's `pnpm dev` builds one (MICA-311).
 *
 * `e2e/fixtures/dev-addon/` is the source of a tiny add-on: a manifest, a service declaration,
 * an in-frame mock of its server half, and a component. This copies the **out-of-tree
 * template** (`tools/addon-template/`) to a temp directory, puts the fixture over its `src/`,
 * links `@mica/sdk` and `@mica/shared` to this checkout and the toolchain to `web/`'s copies,
 * and runs the template's own `vite.config.ts` in development mode as a child Node. So:
 *
 * - the bundle is the one `pnpm dev` would emit — dev entry, mock installed first, iframe
 *   facet set, CSS inlined, `chrome92` target — and it cannot drift from the template's build;
 * - `mica-dev.json` is the file the template's own plugin writes, `isCatalogEntry`-checked,
 *   `sha256` of the exact bytes, `bundleUrl` relative with a `?v=` hash. Nothing here
 *   re-implements either.
 *
 * Offline, as `web/src/lib/addonTemplate.test.ts` is, and for the same reason: the template's
 * `node_modules` is links, so there is nothing to fetch. A child process rather than Vite's JS
 * API in the Playwright worker, so the build's `NODE_ENV` and module state are its own.
 *
 * Nothing built is committed: the temp directory is removed with the worker.
 */

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TEMPLATE_DIR = path.join(ROOT, 'tools/addon-template');
const FIXTURE_DIR = path.join(ROOT, 'web/e2e/fixtures/dev-addon');
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

/** The loopback base the template's `pnpm dev` serves on, and so the one the shell is told. */
export const DEV_BASE = 'http://127.0.0.1:5174/';
/** The fixture's app id: its manifest's `id`. */
export const DEV_APP_ID = 'devprobe';

export interface BuiltDevAddon {
  /** `mica-dev.json`, exactly as the build wrote it. */
  entry: string;
  /** The bundle `entry.bundleUrl` names, exactly as the build wrote it. */
  bundle: string;
  /** `entry.bundleUrl`: relative, with its `?v=` query. */
  bundleUrl: string;
  /** Remove the temp directory. */
  dispose: () => void;
}

export async function buildDevAddon(): Promise<BuiltDevAddon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mica-e2e-dev-addon-'));
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.cpSync(TEMPLATE_DIR, dir, {
      recursive: true,
      filter: (src) =>
        !/^(node_modules|dist|dist-dev|src)(\/|\\|$)/.test(path.relative(TEMPLATE_DIR, src))
    });
    // `*.svelte.src` on disk, `*.svelte` in the build. ESLint's web config types every `.svelte`
    // file through a tsconfig that, deliberately, includes nothing under `e2e/`; a fixture
    // component with the real extension would fail `lint:web` as a parsing error.
    fs.cpSync(FIXTURE_DIR, path.join(dir, 'src'), {
      recursive: true,
      filter: (src) => !src.endsWith('.svelte.src')
    });
    for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.svelte.src'))) {
      fs.copyFileSync(path.join(FIXTURE_DIR, file), path.join(dir, 'src', file.slice(0, -4)));
    }
    const link = (name: string, target: string) => {
      const at = path.join(dir, 'node_modules', name);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(target, at, 'dir');
    };
    link('@mica/sdk', path.join(ROOT, 'sdk'));
    link('@mica/shared', path.join(ROOT, 'shared'));
    for (const name of TOOLCHAIN) {
      link(name, fs.realpathSync(path.join(ROOT, 'web/node_modules', name)));
    }

    // Without this runner's own NODE_ENV: the template's build chooses its own mode.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV'));
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        process.execPath,
        [VITE_BIN, 'build', '--mode', 'development'],
        { cwd: dir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            output: `${stdout}\n${stderr}`
          })
      );
    });
    if (result.code !== 0)
      throw new Error(`the dev add-on fixture did not build:\n${result.output}`);

    const entry = fs.readFileSync(path.join(dir, 'dist-dev/mica-dev.json'), 'utf8');
    const bundleUrl = (JSON.parse(entry) as { bundleUrl: string }).bundleUrl;
    const bundle = fs.readFileSync(path.join(dir, 'dist-dev', `${DEV_APP_ID}.js`), 'utf8');
    return { entry, bundle, bundleUrl, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Every request a spec watched, in order. */
export interface Requests {
  /** The URLs of requests made to `origin`, via the page's own `request` event. */
  to: (origin: string) => string[];
}

/** Watch every request the page makes, whether or not a route answers it. */
export const watchRequests = (page: Page): Requests => {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(request.url()));
  return {
    to: (origin) => seen.filter((url) => new URL(url).origin === origin)
  };
};

const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

/**
 * Serve the built add-on at `DEV_BASE`, as the template's dev server would.
 *
 * `page.route` rather than a real server: the shell's fetches go through the browser's own
 * network stack either way, and Playwright's fulfilled responses are subject to the same CORS
 * and redirect handling as a real one. The one thing a route cannot show is a real socket,
 * which no assertion here needs.
 */
export const serveDevAddon = async (
  page: Page,
  built: BuiltDevAddon
): Promise<{ setBundle: (code: string) => void }> => {
  // What the next request for the bundle is answered with: a rebuild on save, as far as the
  // shell can tell.
  let bundle = built.bundle;
  const bundlePath = `/${built.bundleUrl.split('?')[0]}`;
  await page.route(`${DEV_BASE}**`, (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/mica-dev.json') {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: built.entry
      });
    }
    if (pathname === bundlePath) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/javascript' },
        body: bundle
      });
    }
    return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  });
  return { setBundle: (code) => (bundle = code) };
};
