// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { cutText } from '../lib/import/cutText';

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cutText', () => {
  it('leaves text within the bound alone', () => {
    expect(cutText('hello', 5)).toBe('hello');
    expect(cutText('😀', 2)).toBe('😀');
    expect(cutText('', 0)).toBe('');
  });

  it('cuts plain text at the bound', () => {
    expect(cutText('abcdef', 3)).toBe('abc');
  });

  it('backs off one unit rather than keep half an emoji', () => {
    // 'ab' + 😀 is four units; a cut at three would end on the emoji's high half.
    expect(cutText('ab😀', 3)).toBe('ab');
    expect(cutText('😀😀', 3)).toBe('😀');
    expect(cutText('😀', 1)).toBe('');
  });

  it('never returns more than the bound, nor a lone surrogate', () => {
    const text = 'x😀y👍🏽z🇩🇪'.repeat(20);
    for (let max = 0; max <= text.length + 1; max += 1) {
      const cut = cutText(text, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(LONE);
      expect(text.startsWith(cut)).toBe(true);
    }
  });
});
