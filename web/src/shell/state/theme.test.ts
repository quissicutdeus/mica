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
import { DEFAULT_SEED, TOKEN_NAMES } from '../../lib/m3';

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
    setThemeSeed('not a colour');
    expect(get(themeStore).seed).toBe(DEFAULT_SEED);
  });

  describe('sanitizeTheme', () => {
    it('repairs anything that is not a theme', () => {
      for (const bad of [null, undefined, 'dark', 42, [], {}]) {
        expect(sanitizeTheme(bad)).toEqual(DEFAULT_THEME);
      }
    });

    it('drops a mode nothing renders', () => {
      expect(sanitizeTheme({ seed: '#155dfc', mode: 'light' }).mode).toBe('dark');
    });

    it('keeps a valid seed', () => {
      expect(sanitizeTheme({ seed: '#AABBCC', mode: 'dark' })).toEqual({
        seed: '#aabbcc',
        mode: 'dark'
      });
    });
  });
});
