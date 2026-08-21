import { registerFacet } from '../../current';
import { store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/clock').clock>;

export function clock(): Twin {
  return {
    time: store('clock', [], 'time', { hours: 0, minutes: 0 }),
    is24Hour: store('clock', [], 'is24Hour', false),
    formattedTime: store('clock', [], 'formattedTime', '')
  } as unknown as Twin;
}

registerFacet('clock', clock);
