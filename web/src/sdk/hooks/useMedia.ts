import { media } from '../../services/media';
import { assertCapability } from '../capability';

/**
 * The media gallery — the client face of the `media` service.
 *
 * Split out of `useCamera`, which owned both the hardware and the library. They are
 * used by different apps for different reasons: Media reads the gallery and never
 * touches the shutter, and an app attaching an image to a message wants neither.
 */
export function useMedia() {
  assertCapability('media', 'useMedia');
  return {
    media,
    // `kind` is stated rather than left to the column default: the table holds eight
    // kinds now, and a writer that does not say which one it is means the row's meaning
    // depends on a DDL default nobody reading this file can see.
    capturePhoto: async (data: string) => media.add({ kind: 'photo', data }),
    deletePhoto: async (id: number) => media.delete(id),
    dropNearby: async (mediaId: number) => media.dropNearby(mediaId)
  };
}
