import { registerFacet } from '../../current';
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
} from '../../../../shell/state/wallpaper';
import { seedFromImage } from '../../../../shell/state/seedFromImage';

export type { WallpaperState, WallpaperPreset };

/** Implementation of the `useWallpaper` facet — see the `useWallpaper` hook doc for the usage contract. */
export function wallpaper() {
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

registerFacet('wallpaper', wallpaper);
