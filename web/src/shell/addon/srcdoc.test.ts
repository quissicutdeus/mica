// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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

  /** MICA-24: the frame's `connect-src`, derived from `AppManifest.networkHosts`. */
  describe('connect-src', () => {
    it('blocks outbound fetch entirely when no hosts are given', () => {
      const html = srcdocFor('x');
      expect(html).toContain(
        '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">'
      );
    });

    it('blocks outbound fetch entirely for an explicitly empty list, same as none', () => {
      const html = srcdocFor('x', []);
      expect(html).toContain(
        '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">'
      );
    });

    it('allows exactly the declared origins, space-separated', () => {
      const html = srcdocFor('x', ['https://api.example.com', 'https://cdn.example.com:8443']);
      expect(html).toContain(
        '<meta http-equiv="Content-Security-Policy" content="connect-src https://api.example.com https://cdn.example.com:8443">'
      );
    });

    it('places the CSP meta before any script tag, so it governs the whole document', () => {
      const html = srcdocFor('x', ['https://api.example.com']);
      expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    });
  });
});
