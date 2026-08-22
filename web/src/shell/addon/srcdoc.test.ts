import { describe, it, expect } from 'vitest';
import { srcdocFor } from './srcdoc';

describe('srcdocFor', () => {
  it('produces a document with a root and no allow-same-origin dependency', () => {
    const html = srcdocFor('console.log(1)');
    expect(html).toContain('<div id="app">');
    expect(html).toContain('<script type="module">');
  });

  it('round-trips the code through the data: URL', () => {
    const code = 'export const x = 1;';
    const html = srcdocFor(code);
    const match = html.match(/import\("(data:text\/javascript;charset=utf-8,[^"]+)"\)/);
    expect(match).toBeTruthy();
    const url = match![1];
    const encoded = url.slice('data:text/javascript;charset=utf-8,'.length);
    expect(decodeURIComponent(encoded)).toBe(code);
  });

  it('does not let a `</script>` inside the code terminate the outer script', () => {
    const code = 'const s = "</script><script>alert(1)</script>";';
    const html = srcdocFor(code);
    // The literal, unencoded closing tag must not appear anywhere but the one the
    // document itself needs to end its own module script.
    const scriptCloses = html.match(/<\/script>/g) ?? [];
    expect(scriptCloses).toHaveLength(1);
  });
});
