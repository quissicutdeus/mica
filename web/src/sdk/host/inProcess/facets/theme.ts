import { registerFacet } from '../../current';
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
} from '../../../../shell/state/theme';
import { seedFromRgbString, sanitizeSeed } from '../../../../lib/m3';

export type { ThemeState, ThemeMode };

/** Implementation of the `useTheme` facet — see the `useTheme` hook doc for the usage contract. */
export function theme() {
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

registerFacet('theme', theme);
