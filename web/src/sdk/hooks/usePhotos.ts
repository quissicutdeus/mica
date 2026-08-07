import { photos } from '../../services/photos';

/**
 * The photo gallery — the client face of the `photos` service.
 *
 * Split out of `useCamera`, which owned both the hardware and the library. They are
 * used by different apps for different reasons: Photos reads the gallery and never
 * touches the shutter, and an app attaching an image to a message wants neither.
 */
export function usePhotos() {
  return {
    photos,
    // `kind` is stated rather than left to the column default: the table holds seven
    // kinds now, and a writer that does not say which one it is means the row's meaning
    // depends on a DDL default nobody reading this file can see.
    capturePhoto: async (data: string) => photos.add({ kind: 'photo', data }),
    deletePhoto: async (id: number) => photos.delete(id)
  };
}
