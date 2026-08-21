import { registerFacet } from '../../current';
import { fn, store } from './_shared';
import { constants } from '../constants';

type Twin = ReturnType<typeof import('../../inProcess/facets/display').display>;

export function display(): Twin {
  const c = constants().display;

  return {
    displaySize: store('display', [], 'displaySize', c.displaySizeDefault ?? 50),
    setDisplaySize: fn('display', [], 'setDisplaySize'),
    displaySizeDefault: c.displaySizeDefault,
    phoneScale: store('display', [], 'phoneScale', 1),
    phoneBox: store('display', [], 'phoneBox', { width: 0, height: 0 }),
    isSizeLimited: store('display', [], 'isSizeLimited', false),

    homeGridColumns: store('display', [], 'homeGridColumns', c.homeGridColumnsDefault ?? 4),
    homeGridRows: store('display', [], 'homeGridRows', c.homeGridRowsDefault ?? 5),
    homeGridColumnsDefault: c.homeGridColumnsDefault,
    homeGridColumnsMin: c.homeGridColumnsMin,
    homeGridColumnsMax: c.homeGridColumnsMax,
    homeGridRowsDefault: c.homeGridRowsDefault,
    homeGridRowsMin: c.homeGridRowsMin,
    homeGridRowsMax: c.homeGridRowsMax,

    setHomeGridSize: fn('display', [], 'setHomeGridSize')
  } as unknown as Twin;
}

registerFacet('display', display);
