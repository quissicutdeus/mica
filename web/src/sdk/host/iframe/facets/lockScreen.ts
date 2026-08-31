import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/lockScreen').lockScreen>>;

export function lockScreen(): Twin {
  return {
    hasPasscode: store('lockScreen', [], 'hasPasscode', false),
    autoLockPolicy: store('lockScreen', [], 'autoLockPolicy', 'onClose'),
    autoLockPolicyChoices: store('lockScreen', [], 'autoLockPolicyChoices', [])
  };
}

registerFacet('lockScreen', lockScreen as unknown as Facets['lockScreen']);
