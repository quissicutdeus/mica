/** The document an add-on runs in. Nothing but a root and one module import of the verified text. */
export function srcdocFor(code: string): string {
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#app{height:100%}</style>',
    '</head><body><div id="app"></div>',
    `<script type="module">import(${JSON.stringify(url)}).catch((e) => parent.postMessage({ kind: 'error', message: String(e && e.message || e), stack: null }, '*'));</script>`,
    '</body></html>'
  ].join('');
}
