import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/wallpaperWrite').wallpaperWrite>
>;

/** Implementation of the `useWallpaperWrite` facet — see the inProcess twin for the usage contract. */
export function wallpaperWrite(): Twin {
  return {
    setWallpaperSeed: fn('wallpaperWrite', [], 'setWallpaperSeed'),
    setPresetWallpaper: fn('wallpaperWrite', [], 'setPresetWallpaper'),
    setWallpaperImage: fn('wallpaperWrite', [], 'setWallpaperImage'),
    resetWallpaper: fn('wallpaperWrite', [], 'resetWallpaper')
  };
}

registerFacet('wallpaperWrite', wallpaperWrite);
