// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { DEFAULT_SEED, sanitizeSeed, seedFromRgbString } from './seed';

// MICA-16 step 4: these cases moved out of `m3.test.ts` alongside the functions
// themselves — `sanitizeSeed`/`seedFromRgbString` are now pure and live here so the
// iframe theme twin can import them without the color engine.

describe('seeds', () => {
  it('accepts a six-digit hex and lowercases it', () => {
    expect(sanitizeSeed('#AABBCC')).toBe('#aabbcc');
  });

  it('falls back to the default for anything else', () => {
    for (const bad of ['', '#fff', 'red', 'rgb(1,2,3)', '#gggggg', null, undefined, 42, {}]) {
      expect(sanitizeSeed(bad)).toBe(DEFAULT_SEED);
    }
  });

  it('converts the picker rgba string, dropping the alpha', () => {
    expect(seedFromRgbString('rgba(59, 130, 246, 1)')).toBe('#3b82f6');
    expect(seedFromRgbString('rgba(59, 130, 246, 0.4)')).toBe('#3b82f6');
    expect(seedFromRgbString('rgb(0, 0, 0)')).toBe('#000000');
    expect(seedFromRgbString('not a color')).toBeNull();
  });

  it('round-trips a picked color back through sanitizeSeed', () => {
    const seed = seedFromRgbString('rgba(21, 93, 252, 1)');
    expect(seed).not.toBeNull();
    expect(sanitizeSeed(seed)).toBe(seed);
  });
});
