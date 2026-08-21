import './inProcess/facets/wallpaper';
import { guarded } from './guard';

/**
 * The phone's home screen background.
 */
export function useWallpaper() {
  return guarded('useWallpaper').facets.wallpaper();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name these. */
export type { WallpaperState, WallpaperPreset } from './inProcess/facets/wallpaper';
