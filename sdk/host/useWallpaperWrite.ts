import { guarded } from './guard';

/**
 * OS Service Hook for changing the phone's home screen background (MICA-127) — a preset,
 * a color, or a photo. Separate from `useWallpaper()`, which only reads it.
 */
export function useWallpaperWrite() {
  return guarded('useWallpaperWrite').facets.wallpaperWrite();
}
