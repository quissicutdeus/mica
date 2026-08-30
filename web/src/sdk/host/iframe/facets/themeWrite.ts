import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/themeWrite').themeWrite>>;

/** Implementation of the `useThemeWrite` facet — see the inProcess twin for the usage contract. */
export function themeWrite(): Twin {
  return {
    setThemeSeed: fn('themeWrite', [], 'setThemeSeed'),
    setThemeMode: fn('themeWrite', [], 'setThemeMode'),
    resetTheme: fn('themeWrite', [], 'resetTheme')
  };
}

registerFacet('themeWrite', themeWrite);
