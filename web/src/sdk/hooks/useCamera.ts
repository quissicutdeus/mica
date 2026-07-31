import { photos } from '../../store/photos';

/**
 * OS Service Hook for accessing camera and photo gallery.
 */
export function useCamera() {
  return {
    photosStore: photos,
    capturePhoto: async (image: string) => {
      return photos.add({ image });
    },
    deletePhoto: async (id: number) => {
      return photos.delete(id);
    }
  };
}
