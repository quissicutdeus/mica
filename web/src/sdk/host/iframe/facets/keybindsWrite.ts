import { registerFacet } from '../../current';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/keybindsWrite').keybindsWrite>>;

/** Implementation of the `useKeybindsWrite` facet — see the inProcess twin for the usage contract. */
export function keybindsWrite(): Twin {
  return {
    setBinding: fn('keybindsWrite', [], 'setBinding'),
    resetBindings: fn('keybindsWrite', [], 'resetBindings')
  };
}

registerFacet('keybindsWrite', keybindsWrite);
