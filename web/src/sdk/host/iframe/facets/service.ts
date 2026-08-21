import { registerFacet } from '../../current';
import { fn } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/service').service>;

export function service(serviceId: string): Twin {
  return {
    id: serviceId,
    call: fn('service', [serviceId], 'call')
  } as unknown as Twin;
}
registerFacet('service', service);
