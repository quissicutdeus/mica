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
 *
 * Node's `fetch` transparently decodes `Content-Encoding`, which would make that last
 * check assert nothing, so this uses `node:http` and decompresses by hand.
 *
 *   node scripts/smoke-image.js [baseUrl]      default http://127.0.0.1:8080
 */
import { request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const BASE = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');

/** Raw HTTP: status, headers, and undecoded bytes. */
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

const main = async () => {
  // --- the document ---
  const index = await get('/');
  eq('index 200', 200, index.status);
  eq('index content-type', 'text/html; charset=utf-8', index.headers['content-type']);
  eq('index no-cache', 'no-cache', index.headers['cache-control']);
  const html = index.body.toString('utf8');

  // --- every reference in the HTML resolves ---
  const htmlRefs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1].slice(1));
  for (const ref of htmlRefs) {
    const r = await get(ref);
    if (r.status === 200) {
      ok(`html ref ${ref}`);
    } else {
      bad(`html ref ${ref}`, `status ${r.status}`);
    }
  }

  // --- every url() in every stylesheet resolves ---
  // This is the check that catches font pruning outrunning the CSS that names the fonts.
  let cssRefs = 0;
  for (const css of htmlRefs.filter((r) => r.endsWith('.css'))) {
    const sheet = (await get(css)).body.toString('utf8');
    const dir = css.slice(0, css.lastIndexOf('/'));
    for (const m of sheet.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (m[1].startsWith('data:')) continue;
      const target = `${dir}/${m[1].replace(/^\.\//, '')}`;
      const r = await get(target);
      if (r.status !== 200) bad(`css ref ${target}`, `status ${r.status}`);
      cssRefs++;
    }
  }
  ok(`css refs resolve (${cssRefs} checked)`);

  // --- MIME types that a scratch image gets wrong by default ---
  const js = htmlRefs.find((r) => r.endsWith('.js'));
  const jsRes = await get(js);
  eq('js content-type', 'text/javascript; charset=utf-8', jsRes.headers['content-type']);
  eq('js immutable', 'public, max-age=31536000, immutable', jsRes.headers['cache-control']);

  const anyCss = htmlRefs.find((r) => r.endsWith('.css'));
  const sheet = (await get(anyCss)).body.toString('utf8');
  const font = sheet.match(/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/);
  if (!font) {
    bad('woff2 present', 'no .woff2 referenced by any stylesheet');
  } else {
    const dir = anyCss.slice(0, anyCss.lastIndexOf('/'));
    const fr = await get(`${dir}/${font[1].replace(/^\.\//, '')}`);
    eq('woff2 content-type', 'font/woff2', fr.headers['content-type']);
  }

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
  eq('missing chunk 404', 404, (await get('/assets/definitely-not-real.js')).status);
  eq('stray path falls back', 200, (await get('/some/deep/path')).status);
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
