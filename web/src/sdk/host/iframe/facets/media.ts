import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/media').media>;

export function media(): Twin {
  return {
    media: store('media', [], 'media', []),
    capturePhoto: fn('media', [], 'capturePhoto'),
    deletePhoto: fn('media', [], 'deletePhoto'),
    dropNearby: fn('media', [], 'dropNearby')
  } as unknown as Twin;
}
registerFacet('media', media);
