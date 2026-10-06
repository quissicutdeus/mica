// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Probe a running demo-image container over HTTP.
 *
 * `docker build` succeeding proves the image assembles, not that it serves. Every
 * assertion here is one that failed for real while the image was being built, so this
 * is a regression list rather than a checklist:
 *
 *  - The Dockerfile deletes font files the stylesheets still named, which left 56
 *    `url()`s pointing at 404s. Hence: walk every reference in the HTML *and* the CSS.
 *  - Go's MIME table has no `.woff2` and falls back to `/etc/mime.types`, which does
 *    not exist in a scratch image. Hence: assert the font content-type explicitly.
 *  - The image ships no identity copy of anything compressible; the server inflates it
 *    from the `.gz` at startup. Hence: assert all three encodings decode to identical
 *    bytes, which is the only thing that proves the inflation is correct rather than
 *    merely non-crashing.
 *  - MICA-221 moved the phone bundle from `/` to `/demo/` and put a landing page at the
 *    root, so `/`, `/demo` and `/demo/` are three different documents with three
 *    different fallback rules -- a bundle-only check would not have caught any of them
 *    disagreeing about where the other's files live.
 *  - MICA-237: a stock server's Store fetches the public add-on catalog from
 *    `/addons/sdk-<contract>/catalog.json`, and a phone loads its bundles from the same
 *    tree cross-origin. An image that lacks the file, serves it as HTML, or omits the CORS
 *    header is an empty Store on every stock server with nothing said. Hence: assert 200,
 *    JSON, an empty array, the wildcard header, and that a miss there is a 404 rather
 *    than the demo's HTML fallback.
 *
 * Node's `fetch` transparently decodes `Content-Encoding`, which would make that last
 * check assert nothing, so this uses `node:http` and decompresses by hand.
 *
 *   node scripts/smoke-image.js [baseUrl]      default http://127.0.0.1:8080
 */
import { request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');

/**
 * The SDK contract the public catalog is keyed by, read out of `sdk/version.ts` rather than
 * typed here, so the smoke asks for the URL a stock server's default actually names.
 */
const SDK_CONTRACT = readFileSync(new URL('../sdk/version.ts', import.meta.url), 'utf8').match(
  /export const SDK_CONTRACT_VERSION: string = '([^']+)'/
)?.[1];
if (!SDK_CONTRACT) {
  process.stdout.write(
    '\x1b[31msmoke: could not read SDK_CONTRACT_VERSION from sdk/version.ts\x1b[0m\n'
  );
  process.exit(1);
}

/** Raw HTTP: status, headers, and undecoded bytes. Never follows a redirect itself --
 * the one redirect this server issues (`/demo` -> `/demo/`) is asserted on directly. */
const get = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: BASE.hostname, port: BASE.port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });

const failures = [];
const ok = (name) => process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
const bad = (name, detail) => {
  failures.push(name);
  process.stdout.write(`  \x1b[31m✗ ${name}\x1b[0m — ${detail}\n`);
};
const eq = (name, want, got) => (want === got ? ok(name) : bad(name, `want ${want}, got ${got}`));

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * Every reference in `index.html` and every stylesheet is written `./relative`, the same
 * convention `web/vite.config.ts`'s `base: './'` uses so the bundle works under any
 * subpath. Resolving one against the *document's own* directory, rather than assuming it
 * sits at `/`, is what makes this function work for both the landing page (dir `/`) and
 * the demo bundle (dir `/demo/`).
 */
const resolveRef = (dir, ref) => `${dir}${ref.replace(/^\.\//, '')}`;

/**
 * Fetch a document at `path`, assert the baseline headers every page here shares, and
 * return every `./`-relative reference it makes, resolved to a fetchable path.
 */
const checkDocument = async (label, docPath, dir) => {
  const index = await get(docPath);
  eq(`${label} 200`, 200, index.status);
  eq(`${label} content-type`, 'text/html; charset=utf-8', index.headers['content-type']);
  eq(`${label} no-cache`, 'no-cache', index.headers['cache-control']);
  const html = index.body.toString('utf8');

  const htmlRefs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) =>
    resolveRef(dir, m[1])
  );
  for (const ref of htmlRefs) {
    const r = await get(ref);
    if (r.status === 200) {
      ok(`${label} html ref ${ref}`);
    } else {
      bad(`${label} html ref ${ref}`, `status ${r.status}`);
    }
  }
  return htmlRefs;
};

/** Every `url()` in every referenced stylesheet resolves. Zero stylesheets, or zero
 * `url()`s in them, is a pass -- the landing page has neither. */
const checkCssRefs = async (label, htmlRefs) => {
  let cssRefs = 0;
  for (const css of htmlRefs.filter((r) => r.endsWith('.css'))) {
    const sheet = (await get(css)).body.toString('utf8');
    const dir = css.slice(0, css.lastIndexOf('/') + 1);
    for (const m of sheet.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (m[1].startsWith('data:')) continue;
      const target = resolveRef(dir, m[1]);
      const r = await get(target);
      if (r.status !== 200) bad(`${label} css ref ${target}`, `status ${r.status}`);
      cssRefs++;
    }
  }
  ok(`${label} css refs resolve (${cssRefs} checked)`);
};

/**
 * Kept in step with `MICA_DEV_ADDON_MARKER` in `shared/addonDev.ts` and with the marker in
 * `scripts/check-no-dev-addon.js`, which polices the other direction.
 */
const DEV_ADDON_MARKER = 'mica-dev-addon';

/**
 * Crawl the demo's scripts for `DEV_ADDON_MARKER`, and fail -- loudly -- if it is not found
 * or if there was nothing to crawl.
 *
 * The dev path is imported behind a build flag, so it lands in a chunk of its own that the
 * HTML never names: only the entry's string literals do (`import("./x.js")`, the preload
 * dependency list). Scanning just the entry would report a bundle that has the path as one
 * that lacks it. So this follows every `.js` literal it finds, trying it both relative to
 * the script that named it and to the document, since Vite's preload list is written
 * relative to the base rather than to the chunk. A miss on the server is a 404 (asserted
 * below), never the HTML fallback, so a wrong guess costs a request and proves nothing.
 */
const checkDevAddonPresent = async (entryPaths) => {
  const label = `demo bundle contains "${DEV_ADDON_MARKER}"`;
  if (entryPaths.length === 0) {
    bad(label, 'the demo page references no scripts, so there was nothing to search');
    return;
  }
  const seen = new Set();
  const queue = [...entryPaths];
  let hit;
  while (queue.length > 0 && !hit && seen.size < 1000) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await get(path, { 'Accept-Encoding': 'identity' });
    if (res.status !== 200 || !String(res.headers['content-type']).includes('javascript')) {
      seen.delete(path);
      continue;
    }
    const code = res.body.toString('utf8');
    if (code.includes(DEV_ADDON_MARKER)) {
      hit = path;
      break;
    }
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    for (const m of code.matchAll(/["'`(]((?:\.{1,2}\/)?[\w@.\-/]+\.js)["'`)]/g)) {
      const literal = m[1];
      for (const base of [dir, '/demo/']) {
        const resolved = new URL(literal, `http://x${base}`).pathname;
        if (resolved.startsWith('/demo/') && !seen.has(resolved)) queue.push(resolved);
      }
    }
  }
  if (hit) ok(`${label} (in ${hit})`);
  else
    bad(
      label,
      `searched ${seen.size} script(s) and found none carrying it. The demo image is built ` +
        'with VITE_MICA_ADDON_DEV=1 (Dockerfile); either that stopped taking effect or the ' +
        'dev path is no longer emitted for it'
    );
};

const main = async () => {
  // --- the landing page, at / ---
  // Hand-written HTML/CSS with no build step (docker/landing/), so there is no JS bundle
  // and no font here to check -- only that its own references (style.css, the screenshot)
  // resolve, same as any other document.
  const landingRefs = await checkDocument('landing', '/', '/');
  await checkCssRefs('landing', landingRefs);

  // --- /demo redirects to /demo/ ---
  // Every reference the demo bundle emits is `./relative`; landing on `/demo` without the
  // trailing slash would resolve every one of them one directory too high.
  const bareDemo = await get('/demo');
  eq('/demo redirects', 301, bareDemo.status);
  eq('/demo redirects to /demo/', '/demo/', bareDemo.headers.location);

  // --- the demo bundle, at /demo/ ---
  const demoRefs = await checkDocument('demo', '/demo/', '/demo/');
  await checkCssRefs('demo', demoRefs);

  // --- MIME types that a scratch image gets wrong by default ---
  const js = demoRefs.find((r) => r.endsWith('.js'));
  const jsRes = await get(js);
  eq('js content-type', 'text/javascript; charset=utf-8', jsRes.headers['content-type']);
  eq('js immutable', 'public, max-age=31536000, immutable', jsRes.headers['cache-control']);

  const anyCss = demoRefs.find((r) => r.endsWith('.css'));
  const sheet = (await get(anyCss)).body.toString('utf8');
  const font = sheet.match(/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/);
  if (!font) {
    bad('woff2 present', 'no .woff2 referenced by any stylesheet');
  } else {
    const dir = anyCss.slice(0, anyCss.lastIndexOf('/') + 1);
    const fr = await get(resolveRef(dir, font[1]));
    eq('woff2 content-type', 'font/woff2', fr.headers['content-type']);
  }

  // --- the dev add-on path is in this bundle (MICA-311) ---
  // The opposite of `scripts/check-no-dev-addon.js`, which fails the game build if the path
  // is there. The demo is the one web build that turns it on (`VITE_MICA_ADDON_DEV=1` in the
  // Dockerfile), so a bundle without it means the flag stopped taking effect and nobody can
  // try an add-on against the demo -- with every other check here green.
  await checkDevAddonPresent(demoRefs.filter((r) => r.endsWith('.js')));

  // --- the public add-on catalog, which every stock server's Store fetches ---
  const catalogPath = `/addons/sdk-${SDK_CONTRACT}/catalog.json`;
  const catalog = await get(catalogPath);
  eq('public catalog 200', 200, catalog.status);
  eq(
    'public catalog content-type',
    'application/json; charset=utf-8',
    catalog.headers['content-type']
  );
  eq('public catalog CORS', '*', catalog.headers['access-control-allow-origin']);
  let parsed;
  try {
    parsed = JSON.parse(catalog.body.toString('utf8'));
  } catch (e) {
    bad('public catalog parses as JSON', e.message);
  }
  eq('public catalog is an empty array', '[]', JSON.stringify(parsed));
  const missedBundle = await get(`/addons/sdk-${SDK_CONTRACT}/not-a-bundle.js`);
  eq('public bundle miss 404', 404, missedBundle.status);
  eq('public bundle miss CORS', '*', missedBundle.headers['access-control-allow-origin']);
  eq(
    'demo assets stay without CORS',
    undefined,
    (await get(`/demo/addons/catalog.json`)).headers['access-control-allow-origin']
  );

  // --- the three encodings must decode to the same bytes ---
  const identity = await get(js, { 'Accept-Encoding': 'identity' });
  const gz = await get(js, { 'Accept-Encoding': 'gzip' });
  const br = await get(js, { 'Accept-Encoding': 'br' });
  eq('gzip negotiated', 'gzip', gz.headers['content-encoding']);
  eq('br negotiated', 'br', br.headers['content-encoding']);
  const want = sha(identity.body);
  eq('gzip decodes identically', want, sha(gunzipSync(gz.body)));
  eq('br decodes identically', want, sha(brotliDecompressSync(br.body)));
  eq('br declares content-length', String(br.body.length), br.headers['content-length']);

  // --- routing semantics ---
  eq('missing demo chunk 404', 404, (await get('/demo/assets/definitely-not-real.js')).status);
  eq('stray demo path falls back', 200, (await get('/demo/some/deep/path')).status);
  eq('stray top-level path 404s', 404, (await get('/some/deep/path')).status);
  eq('healthz', 200, (await get('/healthz')).status);

  // --- conditional request ---
  const etag = jsRes.headers.etag;
  eq('304 on If-None-Match', 304, (await get(js, { 'If-None-Match': etag })).status);

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stdout.write(`\x1b[31m${failures.length} smoke check(s) failed.\x1b[0m\n`);
    process.exit(1);
  }
  process.stdout.write('\x1b[32mAll smoke checks passed.\x1b[0m\n');
};

main().catch((e) => {
  process.stdout.write(`\x1b[31msmoke: ${e.message}\x1b[0m\n`);
  process.exit(1);
});
