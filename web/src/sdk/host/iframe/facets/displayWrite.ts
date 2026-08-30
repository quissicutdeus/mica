import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/displayWrite').displayWrite>>;

/** Implementation of the `useDisplayWrite` facet — see the inProcess twin for the usage contract. */
export function displayWrite(): Twin {
  return {
    setDisplaySize: fn('displayWrite', [], 'setDisplaySize'),
    setMotionPreference: fn('displayWrite', [], 'setMotionPreference'),
    setHomeGridSize: fn('displayWrite', [], 'setHomeGridSize')
  };
}

registerFacet('displayWrite', displayWrite);
