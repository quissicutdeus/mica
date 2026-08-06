import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  wallpaperStore,
  wallpaperBackground,
  setWallpaperSeed,
  setPresetWallpaper,
  setWallpaperImage,
  resetWallpaper,
  DEFAULT_WALLPAPER,
  PRESETS
} from './wallpaper';
import { themeStore, resetTheme } from './theme';
import { buildSchemes } from '../../lib/m3';
import { backgroundForSeed } from './wallpaper';

describe('Wallpaper Store', () => {
  beforeEach(() => {
    resetWallpaper();
    resetTheme();
  });

  it('initializes with default preset wallpaper', () => {
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  it('picking a color sets the seed and generates the background from it', () => {
    setWallpaperSeed('#ff0090');
    expect(get(themeStore).seed).toBe('#ff0090');
    expect(get(wallpaperStore)).toEqual({ type: 'color' });
    // Generated, not stored: one input produced both the theme and the picture.
    expect(get(wallpaperBackground)).toBe(backgroundForSeed('#ff0090'));
  });

  it('resets back to default', () => {
    setWallpaperSeed('#123456');
    resetWallpaper();
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
    expect(get(themeStore).seed).toBe(PRESETS[0].seed);
  });

  it('a photo keeps its own picture and may re-seed the colors', () => {
    setWallpaperImage("url('data:image/png;base64,x')", '#00ff00');
    expect(get(wallpaperBackground)).toContain('url(');
    expect(get(themeStore).seed).toBe('#00ff00');
  });

  describe('presets', () => {
    it('declares a hex seed for every preset', () => {
      for (const preset of PRESETS) {
        expect(preset.seed, preset.id).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it('gives each preset its own id and seed', () => {
      expect(new Set(PRESETS.map((p) => p.seed)).size).toBe(PRESETS.length);
      expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    });

    it('generates a visibly different theme for every preset', () => {
      /**
       * The assertion above is necessary and was not sufficient — it is what this file
       * used to check on its own, and it passed while four of six presets rendered the
       * identical theme.
       *
       * M3 builds a scheme from a seed's *hue*, normalizing chroma and discarding
       * lightness. So `#155dfc` and `#1c398e` are different strings, different colors to
       * look at, and the same hue — which makes them the same theme, byte for byte.
       * Clicking between those two presets changed nothing on screen.
       *
       * Distance in RGB rather than equality, because "not identical" is too weak: two
       * seeds a few degrees apart differ by one or two units per channel, which nobody can
       * see. 20 is comfortably above that and well below the ~29 the current set achieves.
       */
      const primaries = PRESETS.map((p) => ({
        id: p.id,
        rgb: buildSchemes(p.seed).dark['primary'].match(/\d+/g)!.map(Number)
      }));

      for (let i = 0; i < primaries.length; i++) {
        for (let j = i + 1; j < primaries.length; j++) {
          const [a, b] = [primaries[i], primaries[j]];
          const distance = Math.hypot(...a.rgb.map((n, k) => n - b.rgb[k]));
          expect(
            Math.round(distance),
            `${a.id} and ${b.id} generate the same theme — pick seeds with different hues`
          ).toBeGreaterThan(20);
        }
      }
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
        expect(get(wallpaperBackground), preset.id).toBe(backgroundForSeed(preset.seed));
      }
    });

    it('restores the default seed on reset', () => {
      setPresetWallpaper(PRESETS[2]);
      resetWallpaper();
      expect(get(themeStore).seed).toBe(PRESETS[0].seed);
    });

    it('leaves the theme alone when a photo carries no seed', () => {
      // A photo wallpaper and a hand-picked accent are allowed to disagree.
      setPresetWallpaper(PRESETS[3]);
      const seed = get(themeStore).seed;
      setWallpaperImage("url('data:image/png;base64,x')");
      expect(get(themeStore).seed).toBe(seed);
    });
  });

  describe('sanitize', () => {
    it('refuses a stored image that is not a url()', () => {
      // It goes straight into a `background` property, so anything else renders as nothing.
      wallpaperStore.set({ type: 'image', image: 'javascript:alert(1)' } as never);
      expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
    });

    it('keeps a stored image that is a url()', () => {
      wallpaperStore.set({ type: 'image', image: "url('data:image/png;base64,x')" });
      expect(get(wallpaperStore).type).toBe('image');
    });

    it('repairs anything that is not a wallpaper', () => {
      for (const bad of [null, undefined, 42, 'preset', { type: 'preset', value: 'x' }]) {
        wallpaperStore.set(bad as never);
        expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
      }
    });
  });
});
