import { registerFacet } from '../../current';
import { setThemeSeed, setThemeMode, resetTheme } from '../../../../shell/state/theme';

/**
 * Implementation of the `useThemeWrite` facet — see the `useThemeWrite` hook doc for the
 * usage contract. Split out of `theme` (MICA-127): reading the current theme and
 * changing the whole phone's colour for every app are not the same ask.
 */
export function themeWrite() {
  return {
    setThemeSeed,
    setThemeMode,
    resetTheme
  };
}

registerFacet('themeWrite', themeWrite);
