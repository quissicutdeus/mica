import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { store, type AsTwin } from './_shared';
import { constants } from '../constants';
import { seedFromRgbString, sanitizeSeed } from '../../../../lib/seed';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/theme').theme>>;

/** Implementation of the `useTheme` facet — see the inProcess twin for the usage contract. */
export function theme(): Twin {
  return {
    themeStore: store('theme', [], 'themeStore', { seed: sanitizeSeed(undefined), mode: 'dark' }),
    schemeStore: store('theme', [], 'schemeStore', {}),
    /** A derived store in the inProcess twin — see `shell/state/theme.ts:71`. */
    isLightMode: store('theme', [], 'isLightMode', false),
    // Carried over the wire as `unknown` (`AddOnConstants`) — see systemHardware.ts.
    defaultTheme: constants().theme.defaultTheme as Twin['defaultTheme'],
    seedFromRgbString,
    sanitizeSeed
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('theme', theme as unknown as Facets['theme']);
