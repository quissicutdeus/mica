import { registerFacet } from '../../current';
import { store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/camera').camera>;

export function camera(): Twin {
  return {
    isTakingPhoto: store('camera', [], 'isTakingPhoto', false),
    isPreviewingPhoto: store('camera', [], 'isPreviewingPhoto', false)
  } as unknown as Twin;
}
registerFacet('camera', camera);
