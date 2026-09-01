// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { placeholderAvatar, placeholderPhoto, placeholderPhotos } from './placeholderImage';

/** Decode the SVG back out of the `data:` URI these produce. */
const decode = (uri: string) => {
  expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
  return decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
};

describe('placeholderImage', () => {
  /**
   * The whole point. These seed from a `citizenid`, so a given person has to keep the
   * same face across reloads, across machines, and across a database reset — otherwise
   * they are just decoration and the mock data may as well hold random URLs.
   */
  it('is deterministic for a given seed', () => {
    expect(placeholderAvatar('gta-ursula')).toBe(placeholderAvatar('gta-ursula'));
    expect(placeholderPhoto('gallery-3')).toBe(placeholderPhoto('gallery-3'));
  });

  it('gives different seeds different images', () => {
    expect(placeholderAvatar('gta-ursula')).not.toBe(placeholderAvatar('gta-michael'));
    expect(placeholderPhoto('a')).not.toBe(placeholderPhoto('b'));
  });

  it('produces well-formed, self-contained SVG', () => {
    for (const uri of [placeholderAvatar('seed'), placeholderPhoto('seed')]) {
      const svg = decode(uri);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      // The reason this module exists: nothing may reach off-box to render.
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    }
  });

  it('mirrors the avatar so it reads as a mark rather than noise', () => {
    // Every drawn cell in columns 0-1 has a partner at 4-x; column 2 is the axis.
    const svg = decode(placeholderAvatar('symmetry'));
    const cells = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map((m) => [
      Number(m[1]),
      Number(m[2])
    ]);
    for (const [x, y] of cells) {
      if (x === 2) continue;
      expect(cells).toContainEqual([4 - x, y]);
    }
  });

  it('never renders an entirely empty avatar', () => {
    // A seed that drew nothing would render as a blank swatch and read as a bug.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(decode(placeholderAvatar(seed))).toContain('<rect x=');
    }
  });

  it('hands back the requested number of distinct photos', () => {
    const photos = placeholderPhotos('gallery', 20);
    expect(photos).toHaveLength(20);
    expect(new Set(photos).size).toBe(20);
  });
});
