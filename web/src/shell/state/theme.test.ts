// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  themeStore,
  schemeStore,
  themeStyleStore,
  setThemeSeed,
  resetTheme,
  sanitizeTheme,
  DEFAULT_THEME
} from './theme';
import { DEFAULT_SEED } from '../../../../sdk/host/seam/theme';
import { TOKEN_NAMES } from '../../../../sdk/lib/m3';

describe('theme store', () => {
  beforeEach(() => {
    resetTheme();
  });

  it('starts on the shipped seed', () => {
    expect(get(themeStore)).toEqual(DEFAULT_THEME);
    expect(get(themeStore).seed).toBe(DEFAULT_SEED);
  });

  it('regenerates every token when the seed changes', () => {
    const before = get(schemeStore);
    setThemeSeed('#ff0090');
    const after = get(schemeStore);

    expect(after['primary']).not.toBe(before['primary']);
    expect(after['surface']).not.toBe(before['surface']);
    expect(Object.keys(after).sort()).toEqual([...TOKEN_NAMES].sort());
  });

  it('keeps the mode when only the seed moves', () => {
    setThemeSeed('#ff0090');
    expect(get(themeStore).mode).toBe('dark');
  });

  it('emits every role as a custom property', () => {
    const style = get(themeStyleStore);
    for (const name of TOKEN_NAMES) {
      expect(style, `--color-${name}`).toContain(`--color-${name}:`);
    }
  });

  it('emits a style string the browser can parse', () => {
    // It goes straight into a `style` attribute, so a malformed value would be dropped
    // silently by the parser rather than raising anything.
    const style = get(themeStyleStore);
    expect(style.split(';').filter(Boolean)).toHaveLength(TOKEN_NAMES.length);
    expect(style).not.toContain('undefined');
    expect(style).not.toContain('NaN');
  });

  it('refuses a seed it cannot generate from', () => {
    // The stored value is player-editable and is one call away from `argbFromHex`.
    setThemeSeed('not a color');
    expect(get(themeStore).seed).toBe(DEFAULT_SEED);
  });

  describe('sanitizeTheme', () => {
    it('repairs anything that is not a theme', () => {
      for (const bad of [null, undefined, 'dark', 42, [], {}]) {
        expect(sanitizeTheme(bad)).toEqual(DEFAULT_THEME);
      }
    });

    it('keeps either mode that renders', () => {
      // This asserted that `light` was dropped, which was right for exactly as long as
      // nothing rendered it. Both schemes have always been generated; the Settings
      // toggle is what made light reachable.
      expect(sanitizeTheme({ seed: '#155dfc', mode: 'light' }).mode).toBe('light');
      expect(sanitizeTheme({ seed: '#155dfc', mode: 'dark' }).mode).toBe('dark');
    });

    it('drops a mode nothing renders', () => {
      for (const bad of ['sepia', '', 0, null, {}]) {
        expect(sanitizeTheme({ seed: '#155dfc', mode: bad }).mode).toBe('dark');
      }
    });

    it('keeps a valid seed', () => {
      expect(sanitizeTheme({ seed: '#AABBCC', mode: 'dark' })).toEqual({
        seed: '#aabbcc',
        mode: 'dark'
      });
    });
  });
});
