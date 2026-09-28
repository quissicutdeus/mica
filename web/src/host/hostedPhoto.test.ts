// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { isHostedPhoto, canBeWallpaper, isUnusableWallpaperImage } from '@mica/shared/hostedPhoto';

const HOST = 'https://img.example.test';

describe('isHostedPhoto', () => {
  it('is a photo with a url', () => {
    expect(isHostedPhoto({ kind: 'photo', url: `${HOST}/p/a.webp` })).toBe(true);
  });
  it('is not a local capture, with or without bytes', () => {
    expect(isHostedPhoto({ kind: 'photo' })).toBe(false);
    expect(isHostedPhoto({ kind: 'photo', url: '' })).toBe(false);
  });
  it('is not a gif or a video, whose url is theirs', () => {
    expect(isHostedPhoto({ kind: 'gif', url: 'https://x.test/a.gif' })).toBe(false);
    expect(isHostedPhoto({ kind: 'video', url: 'https://x.test/a.mp4' })).toBe(false);
  });
});

describe('canBeWallpaper', () => {
  it('takes a local photo with a thumbnail', () => {
    expect(canBeWallpaper({ kind: 'photo', thumbnail: 'data:image/webp;base64,A' })).toBe(true);
  });
  it('refuses a hosted photo, thumbnail or not', () => {
    const row = { kind: 'photo' as const, thumbnail: 'data:image/webp;base64,A', url: `${HOST}/a` };
    expect(canBeWallpaper(row)).toBe(false);
  });
  it('refuses a photo with no thumbnail and anything that is not a photo', () => {
    expect(canBeWallpaper({ kind: 'photo' })).toBe(false);
    expect(canBeWallpaper({ kind: 'audio', thumbnail: 'data:image/webp;base64,A' })).toBe(false);
  });
});

describe('isUnusableWallpaperImage', () => {
  it('refuses an empty source in any quoting', () => {
    for (const v of ["url('')", 'url("")', 'url()']) {
      expect(isUnusableWallpaperImage(v, null)).toBe(true);
    }
  });
  it('refuses a url on the image host, case-insensitively', () => {
    expect(isUnusableWallpaperImage(`url('${HOST}/p/a.webp')`, HOST)).toBe(true);
    expect(isUnusableWallpaperImage(`url('${HOST.toUpperCase()}/p/a.webp')`, HOST)).toBe(true);
  });
  it('refuses the image host however its url is spelled', () => {
    for (const v of [
      "url('//img.example.test/p/a.webp')",
      "url('https://img.example.test:443/p/a.webp')",
      "url('https://img.example.test./p/a.webp')",
      'url( https://IMG.example.test/p/a.webp )'
    ]) {
      expect(isUnusableWallpaperImage(v, HOST), v).toBe(true);
    }
  });
  it('lets through what it cannot name, as the facet did before MICA-293', () => {
    // A remote wallpaper on an add-on's own host, and a value that is not a url() at all.
    expect(isUnusableWallpaperImage("url('https://cdn.addon.test/w.png')", HOST)).toBe(false);
    expect(isUnusableWallpaperImage('linear-gradient(red, blue)', HOST)).toBe(false);
    // A different host that merely starts with the image host's name.
    expect(isUnusableWallpaperImage("url('https://img.example.test.evil.test/a')", HOST)).toBe(
      false
    );
  });
  it('allows a data url and an owner wallpaper', () => {
    expect(isUnusableWallpaperImage("url('data:image/png;base64,AAAA')", HOST)).toBe(false);
    expect(isUnusableWallpaperImage("url('https://cfx-nui-mica/branding/a.png')", HOST)).toBe(
      false
    );
  });
  it('does not treat the host as a match when none is configured', () => {
    expect(isUnusableWallpaperImage(`url('${HOST}/p/a.webp')`, null)).toBe(false);
  });
});
