// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs in Vitest's node environment on purpose: the headless case is the one that used
 * to throw (MICA-177), and only an environment with no `window` can prove it answers.
 * The two real runtimes are stubbed onto `globalThis` for the length of a test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostRuntime, isBrowser } from './isBrowser';

afterEach(() => vi.unstubAllGlobals());

describe('hostRuntime', () => {
  it('answers headless where there is no window, rather than throwing', () => {
    expect(typeof window).toBe('undefined');
    expect(hostRuntime()).toBe('headless');
    expect(isBrowser()).toBe(false);
  });

  it('answers browser for a window with no native bridge', () => {
    vi.stubGlobal('window', {});
    expect(hostRuntime()).toBe('browser');
    expect(isBrowser()).toBe(true);
  });

  it('answers cef for a window carrying invokeNative', () => {
    vi.stubGlobal('window', { invokeNative: () => undefined });
    expect(hostRuntime()).toBe('cef');
    expect(isBrowser()).toBe(false);
  });
});
