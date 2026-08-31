import { registerFacet } from '../../../../sdk/host/current';
import {
  wallpaperStore,
  wallpaperBackground,
  wallpaperNeedsContrast,
  activeSeed,
  backgroundForSeed,
  DEFAULT_WALLPAPER,
  PRESETS
} from '../../shell/state/wallpaper';
import { seedFromImage } from '../../shell/state/seedFromImage';

/**
 * Implementation of the `useWallpaper` facet — see the `useWallpaper` hook doc for the
 * usage contract. Read-only: setting the wallpaper is `useWallpaperWrite` (MICA-127).
 */
export function wallpaper() {
  return {
    wallpaperStore,
    wallpaperBackground,
    /** Whether text drawn over the wallpaper needs the `.text-on-wallpaper` treatment. */
    wallpaperNeedsContrast,
    activeSeed,
    backgroundForSeed,
    seedFromImage,
    presets: PRESETS,
    defaultWallpaper: DEFAULT_WALLPAPER
  };
}

/** @public — SDK surface for add-ons; no in-repo app needs to name these. */

registerFacet('wallpaper', wallpaper);
