import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/admin').admin>;

export function admin(): Twin {
  return {
    isAdmin: store('admin', [], 'isAdmin', false),
    refreshAdmin: fn('admin', [], 'refreshAdmin')
  } as unknown as Twin;
}
registerFacet('admin', admin);
