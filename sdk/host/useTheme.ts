import { guarded } from './guard';

/**
 * Read the phone's color theme.
 *
 * Everything in the SDK is themed from one seed color: an app never names a color, it
 * names a role (`bg-surface-container`, `text-on-surface-variant`) and the role follows
 * whatever the player picked. Read-only — an app that wants to *change* the seed (only
 * Settings and Wallpaper have any business doing that) needs `useThemeWrite` too
 * (MICA-127): declaring one is not declaring the other.
 *
 * `schemeStore` is the resolved token map, for the rare screen that needs a color as a
 * *value* rather than as a class — a canvas fill, an inline SVG gradient. Reach for a
 * utility class first; those are what the theme is actually delivered through.
 */
export function useTheme() {
  return guarded('useTheme').facets.theme();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
export type { ThemeState, ThemeMode } from '../vocabulary/display';
