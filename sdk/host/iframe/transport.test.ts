// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { clientTransport, createClientTransport } from './transport';

// MICA-16 step 4: `clientTransport()` used to throw when called before `bootAddOn()`
// (see boot.ts) had run `setClientTransport`. The addon-entry bundle imports the app's own
// module graph — and therefore evaluates any module-scope `useAppEvents(...).on(...)` call
// it makes (blabber/store.ts) — before `bootAddOn()` gets a chance to run, so a lazily
// created, cached transport is what lets that early call succeed instead of crashing boot.
// This file gets its own module instance (no other test in the suite has called
// `setClientTransport` against it), so `clientTransport()` here observes the "nothing set
// yet" state.

describe('clientTransport', () => {
  it('lazily creates one bound to window when none has been set, and reuses it', () => {
    const first = clientTransport();
    expect(first).toBeDefined();
    const second = clientTransport();
    expect(second).toBe(first);
  });
});

/** A minimal `Window` stand-in: captures the one `message` listener `createClientTransport` adds. */
function fakeWindow() {
  let handler: ((e: MessageEvent) => void) | undefined;
  const win = {
    parent: {},
    addEventListener: (_type: string, cb: (e: MessageEvent) => void) => {
      handler = cb;
    }
  } as unknown as Window;
  return {
    win,
    dispatch: (data: unknown) => handler?.({ data, source: win.parent } as MessageEvent)
  };
}

describe('releaseCallback', () => {
  // MICA-23: a registered callback (onBack/onKeybind/appEvents.on's handler) otherwise
  // lives in this map for the life of the page, even after its subscription ends.
  it('drops a registered callback so an incoming message for it no longer fires', () => {
    const { win, dispatch } = fakeWindow();
    const t = createClientTransport(win);
    const calls: unknown[] = [];
    const handler = (n: unknown) => calls.push(n);
    const id = t.registerCallback(handler);

    dispatch({ kind: 'callback', cb: id, args: [1] });
    expect(calls).toEqual([1]);

    t.releaseCallback(handler);
    dispatch({ kind: 'callback', cb: id, args: [2] });
    expect(calls).toEqual([1]);
  });

  it('is a no-op for a function that was never registered', () => {
    const t = createClientTransport();
    expect(() => t.releaseCallback(() => {})).not.toThrow();
  });
});
