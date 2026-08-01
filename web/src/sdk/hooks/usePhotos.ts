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
    capturePhoto: async (image: string) => photos.add({ image }),
    deletePhoto: async (id: number) => photos.delete(id)
  };
}
