// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { cssUrl, isDataImage, isInlineImage, wallpaperImage } from './imageSource';
import { placeholderPhoto } from '../sdk/lib/placeholderImage';

/**
 * MICA-339. The one definition of what a picture's source may be: the server's client-write
 * rule, `MediaThumb`'s `data` rule and the wallpaper's CSS all read it. Every refusal here has
 * its positive twin, so a rule that refused everything fails too.
 */
const PHOTO = 'data:image/webp;base64,UklGRg==';

describe('isInlineImage', () => {
  it('takes a raster capture and the camera’s SVG stand-in', () => {
    expect(isInlineImage(PHOTO)).toBe(true);
    expect(isInlineImage('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isInlineImage(placeholderPhoto('mica-gallery-0'))).toBe(true);
  });

  it.each([
    'https://logger.attacker.example/p.png',
    `${PHOTO}');display:none;--x:('`,
    `${PHOTO}\nx`,
    'data:text/html;base64,PHNjcmlwdD4=',
    "data:image/svg+xml,%3Csvg')",
    'data:image/svg+xml;base64,PHN2Zz4=',
    ''
  ])('refuses %j', (value) => {
    expect(isInlineImage(value)).toBe(false);
  });
});

describe('isDataImage', () => {
  it('takes any data:image URI and nothing that points anywhere', () => {
    expect(isDataImage('data:image/svg+xml;base64,PHN2Zz4=')).toBe(true);
    expect(isDataImage(PHOTO)).toBe(true);
    for (const value of ['https://x.test/p.png', '//x.test/p.png', ' data:image/png;base64,A', 7]) {
      expect(isDataImage(value), String(value)).toBe(false);
    }
  });
});

describe('cssUrl', () => {
  it('leaves an ordinary source as it is', () => {
    expect(cssUrl('https://cfx-nui-mica/wallpapers/a.jpg')).toBe(
      "url('https://cfx-nui-mica/wallpapers/a.jpg')"
    );
  });

  it('escapes every character that could end the quoted string', () => {
    const inner = cssUrl(`a');display:none;--x:("\\\n`).slice("url('".length, -"')".length);
    expect(inner).not.toMatch(/['"\n]/);
    expect(inner).toBe('a\\27 );display:none;--x:(\\22 \\5c \\a ');
  });
});

describe('wallpaperImage', () => {
  it.each([
    ['an inline photo, wrapped', `url('${PHOTO}')`, `url('${PHOTO}')`],
    ['an inline photo, bare', PHOTO, `url('${PHOTO}')`],
    ['double quotes', `url("${PHOTO}")`, `url('${PHOTO}')`],
    ['no quotes', `url(${PHOTO})`, `url('${PHOTO}')`],
    ['an owner wallpaper', "url('https://cfx-nui-mica/branding/wallpapers/a.jpg')", null],
    ['a mock owner wallpaper path', "url('/branding/wallpapers/a.jpg')", null],
    ['an add-on’s own https host', "url('https://addon.example/bg.webp')", null]
  ])('rebuilds %s', (_label, value, expected) => {
    const out = wallpaperImage(value);
    expect(out).toBe(expected ?? value);
    // Idempotent: what it wrote is what it reads back from storage.
    expect(wallpaperImage(out)).toBe(out);
  });

  it.each([
    ['the F16 breakout', `url('${PHOTO}');display:none;--x:('')`],
    ['a breakout inside the source', `url('${PHOTO}');display:none;--x:(')`],
    ['an http address', "url('http://logger.attacker.example/p.png')"],
    ['a protocol-relative address', "url('//logger.attacker.example/p.png')"],
    ['another scheme', "url('javascript:alert(1)')"],
    ['an address with a quote', "url('https://x.test/a'b.png')"],
    ['an address with a space', "url('https://x.test/a b.png')"],
    ['a non-image data URI', "url('data:text/css;base64,Ym9keXt9')"],
    ['an empty source', "url('')"],
    ['not a string', 42]
  ])('refuses %s', (_label, value) => {
    expect(wallpaperImage(value)).toBeNull();
  });
});
