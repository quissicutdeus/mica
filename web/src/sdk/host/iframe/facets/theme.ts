import { registerFacet } from '../../current';
import { fn, store } from './_shared';
import { constants } from '../constants';
import { seedFromRgbString, sanitizeSeed } from '../../../../lib/seed';

type Twin = ReturnType<typeof import('../../inProcess/facets/theme').theme>;

/** Implementation of the `useTheme` facet — see the inProcess twin for the usage contract. */
export function theme(): Twin {
  return {
    themeStore: store('theme', [], 'themeStore', { seed: sanitizeSeed(undefined), mode: 'dark' }),
    schemeStore: store('theme', [], 'schemeStore', {}),
    setThemeSeed: fn('theme', [], 'setThemeSeed'),
    setThemeMode: fn('theme', [], 'setThemeMode'),
    /** A derived store in the inProcess twin — see `shell/state/theme.ts:71`. */
    isLightMode: store('theme', [], 'isLightMode', false),
    resetTheme: fn('theme', [], 'resetTheme'),
    defaultTheme: constants().theme.defaultTheme,
    seedFromRgbString,
    sanitizeSeed
  } as unknown as Twin;
}

registerFacet('theme', theme);
