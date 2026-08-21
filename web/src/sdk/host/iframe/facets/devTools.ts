import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/devTools').devTools>;

export function devTools(): Twin {
  return {
    devToolsUnlocked: store('devTools', [], 'devToolsUnlocked', false),
    unlock: fn('devTools', [], 'unlock'),
    lock: fn('devTools', [], 'lock')
  } as unknown as Twin;
}

registerFacet('devTools', devTools);
