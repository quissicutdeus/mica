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
export function srcdocFor(code: string): string {
  const escaped = code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#app{height:100%}</style>',
    `<script>window.addEventListener('error', (e) => parent.postMessage({ kind: 'error', message: String((e.error && e.error.message) || e.message), stack: e.error instanceof Error ? (e.error.stack ?? null) : null }, '*'));</script>`,
    '</head><body><div id="app"></div>',
    `<script type="module">${escaped}</script>`,
    '</body></html>'
  ].join('');
}
