import { registerFacet } from '../../current';
import { fn, store } from './_shared';
import { constants } from '../constants';

type Twin = ReturnType<typeof import('../../inProcess/facets/wallpaper').wallpaper>;

export function wallpaper(): Twin {
  const c = constants().wallpaper;

  return {
    wallpaperStore: store('wallpaper', [], 'wallpaperStore', { type: 'color' }),
    wallpaperBackground: store('wallpaper', [], 'wallpaperBackground', ''),
    wallpaperNeedsContrast: store('wallpaper', [], 'wallpaperNeedsContrast', false),
    activeSeed: store('wallpaper', [], 'activeSeed', ''),
    backgroundForSeed: fn('wallpaper', [], 'backgroundForSeed'),
    setWallpaperSeed: fn('wallpaper', [], 'setWallpaperSeed'),
    setPresetWallpaper: fn('wallpaper', [], 'setPresetWallpaper'),
    setWallpaperImage: fn('wallpaper', [], 'setWallpaperImage'),
    resetWallpaper: fn('wallpaper', [], 'resetWallpaper'),
    seedFromImage: fn('wallpaper', [], 'seedFromImage'),
    presets: c.presets,
    defaultWallpaper: c.defaultWallpaper
  } as unknown as Twin;
}

registerFacet('wallpaper', wallpaper);
