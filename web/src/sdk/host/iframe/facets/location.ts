import { registerFacet } from '../../current';
import { fn } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/location').location>;

export function location(): Twin {
  return {
    shareLocation: fn('location', [], 'shareLocation'),
    setWaypoint: fn('location', [], 'setWaypoint')
  } as unknown as Twin;
}
registerFacet('location', location);
