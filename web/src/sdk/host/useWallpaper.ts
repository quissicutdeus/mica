import {
  wallpaperStore,
  wallpaperBackground,
  wallpaperNeedsContrast,
  setWallpaperSeed,
  setPresetWallpaper,
  setWallpaperImage,
  resetWallpaper,
  activeSeed,
  backgroundForSeed,
  DEFAULT_WALLPAPER,
  PRESETS,
  type WallpaperState,
  type WallpaperPreset
} from '../../shell/state/wallpaper';
import { seedFromImage } from '../../shell/state/seedFromImage';

/**
 * The phone's home screen background.
 *
 * A background is a color or a picture, and a color *is* the theme seed — the gradient
 * is generated from the scheme that seed produces, so a preset and a color dragged off a
 * wheel travel the identical path. There is nothing to keep in sync because there is only
 * one input.
 *
 * `seedFromImage` is how a photo becomes a theme: it quantizes the image and returns its
 * dominant color, or `null` if it cannot (a non-`data:` source, a failed decode). `null`
 * means keep the current seed, not "use black".
 */
export function useWallpaper() {
  return {
    wallpaperStore,
    wallpaperBackground,
    /** Whether text drawn over the wallpaper needs the `.text-on-wallpaper` treatment. */
    wallpaperNeedsContrast,
    activeSeed,
    backgroundForSeed,
    setWallpaperSeed,
    setPresetWallpaper,
    setWallpaperImage,
    resetWallpaper,
    seedFromImage,
    presets: PRESETS,
    defaultWallpaper: DEFAULT_WALLPAPER
  };
}

/** @public — SDK surface for add-ons; no in-repo app needs to name these. */
export type { WallpaperState, WallpaperPreset };
