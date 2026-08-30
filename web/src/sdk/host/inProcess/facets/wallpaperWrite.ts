import { registerFacet } from '../../current';
import {
  setWallpaperSeed,
  setPresetWallpaper,
  setWallpaperImage,
  resetWallpaper
} from '../../../../shell/state/wallpaper';

/**
 * Implementation of the `useWallpaperWrite` facet — see the `useWallpaperWrite` hook doc
 * for the usage contract. Split out of `wallpaper` (MICA-127): reading the current
 * background and replacing the whole phone's are not the same ask.
 */
export function wallpaperWrite() {
  return {
    setWallpaperSeed,
    setPresetWallpaper,
    setWallpaperImage,
    resetWallpaper
  };
}

registerFacet('wallpaperWrite', wallpaperWrite);
