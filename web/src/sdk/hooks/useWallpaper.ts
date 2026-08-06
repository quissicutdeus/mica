import {
  wallpaperStore,
  setWallpaper,
  setPresetWallpaper,
  resetWallpaper,
  DEFAULT_WALLPAPER,
  PRESETS,
  type WallpaperState,
  type WallpaperPreset
} from '../../shell/state/wallpaper';
import { seedFromImage } from '../../shell/state/seedFromImage';

/**
 * The phone's home screen background.
 *
 * A wallpaper carries a **seed** as well as a picture, because the two are not
 * independent: the M3 theme is generated from a colour, and a screen whose chrome
 * ignores its own background is the thing this replaced. `setPresetWallpaper` moves
 * both; `setWallpaper` takes the seed as an optional second argument so a player can
 * also keep one and change the other.
 *
 * `seedFromImage` is how a photo becomes a theme — it quantizes the image and returns
 * its dominant colour, or `null` if it cannot (a non-`data:` source, a failed decode).
 * `null` means keep the current seed, not "use black".
 */
export function useWallpaper() {
  return {
    wallpaperStore,
    setWallpaper,
    setPresetWallpaper,
    resetWallpaper,
    seedFromImage,
    presets: PRESETS,
    defaultWallpaper: DEFAULT_WALLPAPER
  };
}

export type { WallpaperState, WallpaperPreset };
