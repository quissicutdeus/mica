import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/clockWrite').clockWrite>>;

/** Implementation of the `useClockWrite` facet — see the inProcess twin for the usage contract. */
export function clockWrite(): Twin {
  return {
    setIs24Hour: fn('clockWrite', [], 'setIs24Hour')
  };
}

registerFacet('clockWrite', clockWrite);
