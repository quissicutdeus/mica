import './inProcess/facets/wallpaper';
import { guarded } from './guard';

/**
 * The phone's home screen background — read-only. Changing it is `useWallpaperWrite`
 * (MICA-127): reading the current background and replacing the whole phone's are not
 * the same ask.
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
  return guarded('useWallpaper').facets.wallpaper();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name these. */
export type { WallpaperState, WallpaperPreset } from './inProcess/facets/wallpaper';
