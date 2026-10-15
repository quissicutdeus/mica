// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  installGlobalErrors,
  NEW_SITE_LIMIT,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  SEEN_LIMIT,
  uninstallGlobalErrors
} from './globalErrors';

/**
 * Node environment, on purpose: the catcher takes any `EventTarget`, and Node has one. Node
 * has no `ErrorEvent` or `PromiseRejectionEvent`, so the fields the browser would set are
 * put on a plain `Event` — the catcher only reads them.
 */
function errorEvent(error: unknown, extra: Record<string, unknown> = {}): Event {
  const event = new Event('error', { cancelable: true });
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(event, { error, message, ...extra });
}

function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason });
}

/** An Error with a fixed stack, so its first frame — and so its dedupe key — is chosen. */
function withStack(message: string, frame: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame}\n    at caller (shell.js:1:1)`;
  return error;
}

let target: EventTarget;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.useFakeTimers();
  target = new EventTarget();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallGlobalErrors(target);
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe('installGlobalErrors', () => {
  it('logs an uncaught error once, prefixed, with its stack', () => {
    installGlobalErrors(target);
    const error = withStack('boom', 'onClick (app.js:10:5)');

    target.dispatchEvent(errorEvent(error));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[micaOS] Uncaught error:', error.stack);
  });

  it('logs an unhandled rejection once, prefixed, with its stack', () => {
    installGlobalErrors(target);
    const error = withStack('nope', 'load (store.js:3:1)');

    target.dispatchEvent(rejectionEvent(error));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[micaOS] Unhandled promise rejection:', error.stack);
  });

  it('falls back to the message and location when there is no stack', () => {
    installGlobalErrors(target);

    target.dispatchEvent(
      errorEvent(null, { message: 'Script error.', filename: 'x.js', lineno: 4, colno: 2 })
    );
    target.dispatchEvent(rejectionEvent('plain string reason'));

    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[micaOS] Uncaught error:',
      'Script error. (x.js:4:2)'
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '[micaOS] Unhandled promise rejection:',
      'plain string reason'
    );
  });

  it('survives a rejection reason that cannot be stringified', () => {
    installGlobalErrors(target);
    const hostile = {
      toString() {
        throw new Error('no');
      }
    };

    target.dispatchEvent(rejectionEvent(hostile));

    expect(errorSpy).toHaveBeenCalledWith(
      '[micaOS] Unhandled promise rejection:',
      '[unprintable value]'
    );
  });

  it('never cancels the event, so devtools still reports the original', () => {
    installGlobalErrors(target);
    const error = errorEvent(withStack('boom', 'f (a.js:1:1)'));
    const rejection = rejectionEvent(new Error('nope'));

    expect(target.dispatchEvent(error)).toBe(true);
    expect(target.dispatchEvent(rejection)).toBe(true);
    expect(error.defaultPrevented).toBe(false);
    expect(rejection.defaultPrevented).toBe(false);
  });

  it('dedupes a repeat with the same message and first frame', () => {
    installGlobalErrors(target);

    for (let i = 0; i < 50; i++) {
      target.dispatchEvent(errorEvent(withStack('tick failed', 'frame (loop.js:9:9)')));
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps errors apart that share a message but not a first frame, or not a kind', () => {
    installGlobalErrors(target);

    target.dispatchEvent(errorEvent(withStack('same', 'a (a.js:1:1)')));
    target.dispatchEvent(errorEvent(withStack('same', 'b (b.js:1:1)')));
    target.dispatchEvent(rejectionEvent(withStack('same', 'a (a.js:1:1)')));

    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it('caps a burst of distinct errors and summarises the rest when the window closes', () => {
    installGlobalErrors(target);

    for (let i = 0; i < 100; i++) {
      target.dispatchEvent(errorEvent(withStack(`frame ${i} failed`, 'loop (loop.js:1:1)')));
    }

    expect(errorSpy).toHaveBeenCalledTimes(RATE_LIMIT);

    vi.advanceTimersByTime(RATE_WINDOW_MS);

    expect(errorSpy).toHaveBeenCalledTimes(RATE_LIMIT + 1);
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\[micaOS\] 90 further uncaught error\(s\) not printed/)
    );
  });

  it('prints a one-off error from a new frame in the middle of a capped storm', () => {
    installGlobalErrors(target);
    const storm = (from: number) => {
      for (let i = from; i < from + 50; i++) {
        target.dispatchEvent(errorEvent(withStack(`frame ${i} failed`, 'loop (loop.js:1:1)')));
      }
    };
    const real = withStack('balance is undefined', 'save (bank.js:5:5)');

    storm(0);
    target.dispatchEvent(errorEvent(real));
    storm(50);

    expect(errorSpy).toHaveBeenCalledWith('[micaOS] Uncaught error:', real.stack);
  });

  it('still bounds a stream of errors that each come from a new frame', () => {
    installGlobalErrors(target);

    for (let i = 0; i < 100; i++) {
      target.dispatchEvent(errorEvent(withStack(`e${i}`, `f${i} (a.js:${i}:1)`)));
    }

    expect(errorSpy).toHaveBeenCalledTimes(NEW_SITE_LIMIT);
    vi.advanceTimersByTime(RATE_WINDOW_MS);
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`^\\[micaOS\\] ${100 - NEW_SITE_LIMIT} further`))
    );
  });

  it('prints a capped error once the window reopens, since it was never seen', () => {
    installGlobalErrors(target);
    for (let i = 0; i < RATE_LIMIT; i++) {
      target.dispatchEvent(errorEvent(withStack(`e${i}`, 'f (a.js:1:1)')));
    }
    const late = withStack('late', 'f (a.js:1:1)');

    target.dispatchEvent(errorEvent(late));
    vi.advanceTimersByTime(RATE_WINDOW_MS);
    errorSpy.mockClear();
    target.dispatchEvent(errorEvent(late));

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith('[micaOS] Uncaught error:', late.stack);
  });

  it(`forgets the oldest identity past ${SEEN_LIMIT}, so the set stays bounded`, () => {
    installGlobalErrors(target);
    const first = withStack('first', 'f (a.js:1:1)');
    target.dispatchEvent(errorEvent(first));
    for (let i = 0; i < SEEN_LIMIT; i++) {
      vi.advanceTimersByTime(RATE_WINDOW_MS);
      target.dispatchEvent(errorEvent(withStack(`filler ${i}`, 'f (a.js:1:1)')));
    }
    errorSpy.mockClear();

    target.dispatchEvent(errorEvent(first));

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not double-log when installed twice, as Vite HMR re-running main.ts would', () => {
    installGlobalErrors(target);
    installGlobalErrors(target);

    target.dispatchEvent(errorEvent(withStack('boom', 'f (a.js:1:1)')));
    target.dispatchEvent(rejectionEvent(withStack('nope', 'g (b.js:1:1)')));

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('logs nothing after uninstall, by either the returned function or the export', () => {
    const uninstall = installGlobalErrors(target);
    uninstall();
    target.dispatchEvent(errorEvent(withStack('a', 'f (a.js:1:1)')));

    installGlobalErrors(target);
    uninstallGlobalErrors(target);
    target.dispatchEvent(rejectionEvent(withStack('b', 'f (a.js:1:1)')));

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a stale uninstall from a replaced install leaves the live one attached', () => {
    const stale = installGlobalErrors(target);
    installGlobalErrors(target);

    stale();
    target.dispatchEvent(errorEvent(withStack('boom', 'f (a.js:1:1)')));

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
