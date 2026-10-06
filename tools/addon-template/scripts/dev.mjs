/**
 * `pnpm dev`: rebuild on save, serve the result on loopback, and print the link that opens it
 * in the demo phone.
 *
 * Two of Vite's own pieces, through its JS API, so nothing is installed for this:
 *
 * - a **watch build** in development mode, which is `pnpm build` plus the in-frame mock of your
 *   server half (`src/mock.ts`) and `mica-dev.json`, the catalog entry the phone reads — all
 *   written to `dist-dev/`, never to `dist/`, which stays what `pnpm build` makes and you publish;
 * - **`vite preview`** over `dist-dev/`, on `127.0.0.1:5174` only. Loopback, because the phone
 *   refuses a dev add-on from anywhere else; a fixed port with `strictPort`, so a second copy
 *   fails loudly instead of quietly serving from another port the link does not name.
 *
 * The demo phone is a page on `https://mica.gg`, fetching from your machine. That needs CORS
 * for its origin (and for a phone served from loopback, as micaOS's own `pnpm dev` is), and
 * Chrome's Private Network Access answer, `Access-Control-Allow-Private-Network: true`, on the
 * preflight it sends before a public page may reach a private address.
 */
import { build, preview } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const configFile = path.join(root, 'vite.config.ts');

const HOST = '127.0.0.1';
const PORT = 5174;
const BASE = `http://${HOST}:${PORT}/`;
const DEMO = 'https://mica.gg/demo/';

/** Origins that may fetch from this server: the public demo, and any loopback phone. */
const ALLOWED_ORIGINS = ['https://mica.gg', /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/];

const allowed = (origin) =>
  typeof origin === 'string' &&
  ALLOWED_ORIGINS.some((rule) => (typeof rule === 'string' ? rule === origin : rule.test(origin)));

/**
 * After Vite's own CORS middleware, which sets the CORS headers and — with `preflightContinue`
 * below — hands a preflight on instead of answering it, so this can add Chrome's Private
 * Network Access answer to it and end it. `no-store` as well: the phone re-reads the entry on
 * every load, and a cached one would name the previous bundle.
 */
const privateNetwork = {
  name: 'mica-addon-dev-private-network',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (allowed(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
      next();
    });
  }
};

/** Resolve once the first build has finished, or reject if it failed. */
const firstBuild = (watcher) =>
  new Promise((resolve, reject) => {
    const onEvent = (event) => {
      if (event.code === 'END') {
        watcher.off('event', onEvent);
        resolve();
      } else if (event.code === 'ERROR') {
        watcher.off('event', onEvent);
        reject(event.error);
      }
      if ('result' in event && event.result) void event.result.close?.();
    };
    watcher.on('event', onEvent);
  });

const watcher = await build({
  root,
  configFile,
  mode: 'development',
  build: { watch: {} }
});
if (!('on' in watcher)) {
  throw new Error('[mica-addon] the watch build did not start a watcher.');
}
await firstBuild(watcher);

const server = await preview({
  root,
  configFile,
  mode: 'development',
  plugins: [privateNetwork],
  preview: {
    host: HOST,
    port: PORT,
    strictPort: true,
    cors: { origin: ALLOWED_ORIGINS, preflightContinue: true }
  }
});

console.log(
  [
    '',
    `  Serving ${BASE} — rebuilt on every save.`,
    '',
    '  Open your add-on in the demo phone:',
    `  ${DEMO}?addonDev=${BASE}`,
    '',
    '  Your server half is src/mock.ts here; nothing reaches a FiveM server.',
    ''
  ].join('\n')
);

const stop = async () => {
  await watcher.close();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
