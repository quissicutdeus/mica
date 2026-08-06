import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  wallpaperStore,
  setWallpaper,
  setPresetWallpaper,
  resetWallpaper,
  DEFAULT_WALLPAPER,
  PRESETS
} from './wallpaper';
import { themeStore, resetTheme } from './theme';

describe('Wallpaper Store', () => {
  beforeEach(() => {
    resetWallpaper();
    resetTheme();
  });

  it('initializes with default preset wallpaper', () => {
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  it('updates wallpaper to a solid color', () => {
    setWallpaper({ type: 'color', value: 'rgba(59, 130, 246, 0.9)' });
    expect(get(wallpaperStore)).toEqual({
      type: 'color',
      value: 'rgba(59, 130, 246, 0.9)'
    });
  });

  it('resets back to default', () => {
    setWallpaper({ type: 'color', value: '#123456' });
    resetWallpaper();
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  describe('presets', () => {
    it('declares a hex seed for every preset', () => {
      for (const preset of PRESETS) {
        expect(preset.seed, preset.id).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it('gives each preset its own seed and value', () => {
      expect(new Set(PRESETS.map((p) => p.seed)).size).toBe(PRESETS.length);
      expect(new Set(PRESETS.map((p) => p.value)).size).toBe(PRESETS.length);
      expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    });

    it('moves the theme seed with the wallpaper', () => {
      // The regression test for what this replaced. The old `themeStyleStore` derived a
      // theme by substring-matching the class string, so `ocean_blue` matched its
      // `blue` branch through `indigo-950` and `sunset_purple` matched `purple` while
      // discarding its pink and rose. Asserting the declared seed arrives means there is
      // nothing left to infer, correctly or otherwise.
      for (const preset of PRESETS) {
        setPresetWallpaper(preset);
        expect(get(themeStore).seed, preset.id).toBe(preset.seed);
        expect(get(wallpaperStore).value).toBe(preset.value);
      }
    });

    it('restores the default seed on reset', () => {
      setPresetWallpaper(PRESETS[2]);
      resetWallpaper();
      expect(get(themeStore).seed).toBe(PRESETS[0].seed);
    });

    it('leaves the theme alone when no seed is given', () => {
      // A photo wallpaper and a hand-picked accent are allowed to disagree.
      setPresetWallpaper(PRESETS[3]);
      const seed = get(themeStore).seed;
      setWallpaper({ type: 'image', value: "url('data:image/png;base64,x') center/cover" });
      expect(get(themeStore).seed).toBe(seed);
    });
  });

  describe('sanitize', () => {
    it('rejects a preset class that is no longer in the list', () => {
      // A stored class Tailwind never compiled renders as no background at all, with no
      // error anywhere — so a renamed preset must not survive in storage.
      wallpaperStore.set({ type: 'preset', value: 'bg-gradient-to-br from-lime-100 to-lime-200' });
      expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
    });

    it('keeps a preset class that is still in the list', () => {
      wallpaperStore.set({ type: 'preset', value: PRESETS[1].value });
      expect(get(wallpaperStore).value).toBe(PRESETS[1].value);
    });

    it('repairs anything that is not a wallpaper', () => {
      for (const bad of [null, undefined, 42, 'preset', {}, { type: 'preset' }, { value: '' }]) {
        wallpaperStore.set(bad as never);
        expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
      }
    });
  });
});
