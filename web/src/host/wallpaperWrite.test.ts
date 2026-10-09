// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import './registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { wallpaperWrite } from './facets/wallpaperWrite';
import { wallpaperStore, DEFAULT_WALLPAPER } from '../shell/state/wallpaper';
import { imageHostOrigin } from '../services/imageHost';

const HOST = 'https://img.example.test';

describe('wallpaperWrite.setWallpaperImage (MICA-293)', () => {
  beforeEach(() => {
    wallpaperStore.set(DEFAULT_WALLPAPER);
    imageHostOrigin.set(HOST);
  });

  it('refuses a photo on the image host, and leaves the wallpaper alone', () => {
    const { setWallpaperImage } = wallpaperWrite();
    expect(() => setWallpaperImage(`url('${HOST}/p/a.webp')`)).toThrow(/image host/);
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  it('refuses an empty image, which is what a hosted photo has for data', () => {
    const { setWallpaperImage } = wallpaperWrite();
    expect(() => setWallpaperImage("url('')")).toThrow(/image host/);
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  /**
   * MICA-339 (F16). An add-on's string reached PhoneFrame's `style` as it was passed; a `'`
   * in it closed the CSS string and the rest styled the phone screen. It is refused now, and
   * an add-on's ordinary https wallpaper still sets.
   */
  it('refuses an add-on string that breaks out of url(), and sets an https one', () => {
    const { setWallpaperImage } = wallpaperWrite();
    expect(() =>
      setWallpaperImage("url('https://addon.example/a.png');display:none;--x:('')")
    ).toThrow(/wallpaper/);
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);

    setWallpaperImage("url('https://addon.example/a.png')");
    expect(get(wallpaperStore)).toEqual({
      type: 'image',
      image: "url('https://addon.example/a.png')"
    });
  });

  it('still sets a data url', () => {
    const { setWallpaperImage } = wallpaperWrite();
    const image = "url('data:image/png;base64,AAAA')";
    setWallpaperImage(image);
    expect(get(wallpaperStore)).toEqual({ type: 'image', image });
  });
});
