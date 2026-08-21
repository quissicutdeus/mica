import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/navigation').navigation>;

export function navigation(): Twin {
  return {
    currentApp: store('navigation', [], 'currentApp', { id: '', props: {} }),
    openApp: fn('navigation', [], 'openApp'),
    goHome: fn('navigation', [], 'goHome'),
    closePhone: fn('navigation', [], 'closePhone'),
    consumeDeepLink: fn('navigation', [], 'consumeDeepLink')
  } as unknown as Twin;
}

registerFacet('navigation', navigation);
