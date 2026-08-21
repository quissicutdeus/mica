import {
  themeStore,
  schemeStore,
  setThemeSeed,
  setThemeMode,
  isLightMode,
  resetTheme,
  DEFAULT_THEME,
  type ThemeState,
  type ThemeMode
} from '../../shell/state/theme';
import { seedFromRgbString, sanitizeSeed } from '../../lib/m3';

/**
 * Read and change the phone's color theme.
 *
 * Everything in the SDK is themed from one seed color: an app never names a color, it
 * names a role (`bg-surface-container`, `text-on-surface-variant`) and the role follows
 * whatever the player picked. So the only thing an app has any business setting is the
 * seed, and that is all this exposes.
 *
 * `schemeStore` is the resolved token map, for the rare screen that needs a color as a
 * *value* rather than as a class — a canvas fill, an inline SVG gradient. Reach for a
 * utility class first; those are what the theme is actually delivered through.
 */
export function useTheme() {
  return {
    themeStore,
    schemeStore,
    setThemeSeed,
    setThemeMode,
    isLightMode,
    resetTheme,
    defaultTheme: DEFAULT_THEME,
    /** Convert an `rgb()`/`rgba()` string — what a color picker emits — into a seed. */
    seedFromRgbString,
    sanitizeSeed
  };
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
export type { ThemeState, ThemeMode };
