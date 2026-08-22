import { describe, it, expect } from 'vitest';
import { srcdocFor } from './srcdoc';

describe('srcdocFor', () => {
  it('produces a document with a root and no allow-same-origin dependency', () => {
    const html = srcdocFor('console.log(1)');
    expect(html).toContain('<div id="app">');
    expect(html).toContain('<script type="module">');
  });

  it('inlines the code directly, not as a data: URL', () => {
    const code = 'export const x = 1;';
    const html = srcdocFor(code);
    expect(html).not.toContain('data:text/javascript');
    expect(html).toContain(`<script type="module">${code}</script>`);
  });

  it('stays within ~5% of the source size, not the ~3x a data: URL would cost', () => {
    const code = 'x'.repeat(10000);
    const html = srcdocFor(code);
    expect(html.length).toBeLessThan(code.length * 1.05 + 1000);
  });

  it('does not let a `</script>` inside the code terminate the outer script', () => {
    const code = 'const s = "</script><script>alert(1)</script>";';
    const html = srcdocFor(code);
    // Two script tags belong to the document itself (the fallback error listener,
    // and the module script). None of the extra closes come from inside the code.
    const scriptCloses = html.match(/<\/script>/g) ?? [];
    expect(scriptCloses).toHaveLength(2);
  });
});
