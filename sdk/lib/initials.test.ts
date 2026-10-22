// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { initialsOf } from './initials';

describe('initialsOf (MICA-417)', () => {
  it('takes the first letter of the first and last word of two or more', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada king lovelace')).toBe('AL');
    expect(initialsOf('  Grace   Hopper  ')).toBe('GH');
  });

  it('takes one letter of a single word, uppercased', () => {
    expect(initialsOf('ada')).toBe('A');
    expect(initialsOf('Zed')).toBe('Z');
  });

  it('drops a leading @ so a handle and a name agree', () => {
    expect(initialsOf('@ada_l')).toBe('A');
    expect(initialsOf('@ada lovelace')).toBe('AL');
  });

  it("answers the caller's fallback, '?' by default, with nothing to draw", () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('@')).toBe('?');
    expect(initialsOf(undefined)).toBe('?');
    expect(initialsOf(null, '#')).toBe('#');
    expect(initialsOf('', '')).toBe('');
  });

  it('draws a whole code point, not half a surrogate pair', () => {
    expect(initialsOf('😀 party')).toBe('😀P');
  });
});
