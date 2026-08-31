import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/lockScreenWrite').lockScreenWrite>
>;

/** Implementation of the `useLockScreenWrite` facet — see the inProcess twin for the usage contract. */
export function lockScreenWrite(): Twin {
  return {
    setAutoLockPolicy: fn('lockScreenWrite', [], 'setAutoLockPolicy'),
    setPasscode: fn('lockScreenWrite', [], 'setPasscode'),
    clearPasscode: fn('lockScreenWrite', [], 'clearPasscode')
  };
}

registerFacet('lockScreenWrite', lockScreenWrite);
