import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/phoneNotification').phoneNotification>;

export function phoneNotification(): Twin {
  return {
    sendNotification: fn('phoneNotification', [], 'sendNotification'),
    dismissNotification: fn('phoneNotification', [], 'dismissNotification'),
    toast: store('phoneNotification', [], 'toast', [])
  } as unknown as Twin;
}

registerFacet('phoneNotification', phoneNotification);
