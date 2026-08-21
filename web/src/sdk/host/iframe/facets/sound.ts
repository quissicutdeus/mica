import { registerFacet } from '../../current';
import { fn } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/sound').sound>;

export function sound(): Twin {
  return {
    play: fn('sound', [], 'play')
  } as unknown as Twin;
}

registerFacet('sound', sound);
