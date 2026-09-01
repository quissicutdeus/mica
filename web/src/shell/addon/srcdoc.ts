// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-24: the frame's `connect-src`, built from `AppManifest.networkHosts`.
 *
 * Only `connect-src` — every other directive is left unset (unrestricted, same as
 * before this existed). This is deliberately narrow: the ticket this closes is about
 * outbound `fetch()` to an arbitrary host, and tightening `script-src`/`style-src` too
 * would risk breaking Svelte's own runtime-injected `<style>` tags and the inlined
 * module script itself, with no browser or game client in reach to verify against.
 *
 * An empty list is `'none'`, not an omitted directive — CSP has no bare "block
 * everything" keyword for one directive alone, and omitting `connect-src` entirely
 * would mean unrestricted by default, the opposite of what an app declaring no hosts
 * (or no `networkHosts` at all) is asking for.
 */
function connectSrcFor(networkHosts: readonly string[]): string {
  const sources = networkHosts.length > 0 ? networkHosts.join(' ') : "'none'";
  return `<meta http-equiv="Content-Security-Policy" content="connect-src ${sources}">`;
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
    connectSrcFor(networkHosts),
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#app{height:100%}</style>',
    `<script>window.addEventListener('error', (e) => parent.postMessage({ kind: 'error', message: String((e.error && e.error.message) || e.message), stack: e.error instanceof Error ? (e.error.stack ?? null) : null }, '*'));</script>`,
    '</head><body><div id="app"></div>',
    `<script type="module">${escaped}</script>`,
    '</body></html>'
  ].join('');
}
