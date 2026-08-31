import { guarded } from './guard';

/**
 * OS Service Hook for changing the phone's colour theme (MICA-127) — the seed, the
 * mode, and resetting either. Separate from `useTheme()`, which only reads it: a player
 * picking a wallpaper photo or dragging the color wheel is a far bigger ask than an app
 * rendering itself in whatever theme is already active, and the two used to be one
 * permission.
 */
export function useThemeWrite() {
  return guarded('useThemeWrite').facets.themeWrite();
}
