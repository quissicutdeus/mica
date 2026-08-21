import { registerFacet } from '../../current';
import { media as mediaService } from '../../../../services/media';

/**
 * The media gallery — the client face of the `media` service.
 *
 * Split out of `useCamera`, which owned both the hardware and the library. They are
 * used by different apps for different reasons: Media reads the gallery and never
 * touches the shutter, and an app attaching an image to a message wants neither.
 */
export function media() {
  return {
    media: mediaService,
    // `kind` is stated rather than left to the column default: the table holds eight
    // kinds now, and a writer that does not say which one it is means the row's meaning
    // depends on a DDL default nobody reading this file can see.
    capturePhoto: async (data: string) => mediaService.add({ kind: 'photo', data }),
    deletePhoto: async (id: number) => mediaService.delete(id),
    dropNearby: async (mediaId: number) => mediaService.dropNearby(mediaId)
  };
}

registerFacet('media', media);
