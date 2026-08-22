import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';
import { constants } from '../constants';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/wallpaper').wallpaper>>;

export function wallpaper(): Twin {
  const c = constants().wallpaper;

  return {
    wallpaperStore: store('wallpaper', [], 'wallpaperStore', { type: 'color' }),
    wallpaperBackground: store('wallpaper', [], 'wallpaperBackground', ''),
    wallpaperNeedsContrast: store('wallpaper', [], 'wallpaperNeedsContrast', false),
    activeSeed: store('wallpaper', [], 'activeSeed', ''),
    // Sync in-process (pure derivation from the seed); async over the wire.
    backgroundForSeed: fn(
      'wallpaper',
      [],
      'backgroundForSeed'
    ) as unknown as Twin['backgroundForSeed'],
    setWallpaperSeed: fn('wallpaper', [], 'setWallpaperSeed'),
    setPresetWallpaper: fn('wallpaper', [], 'setPresetWallpaper'),
    setWallpaperImage: fn('wallpaper', [], 'setWallpaperImage'),
    resetWallpaper: fn('wallpaper', [], 'resetWallpaper'),
    seedFromImage: fn('wallpaper', [], 'seedFromImage'),
    // Carried over the wire as `unknown` (`AddOnConstants`) — see systemHardware.ts.
    presets: c.presets as Twin['presets'],
    defaultWallpaper: c.defaultWallpaper as Twin['defaultWallpaper']
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('wallpaper', wallpaper as unknown as Facets['wallpaper']);
