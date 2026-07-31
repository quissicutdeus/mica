import { photos } from '../../store/photos';
import { isTakingPhoto, isPreviewingPhoto } from '../../store/camera';

/**
 * OS Service Hook for accessing camera and photo gallery.
 */
export function useCamera() {
  return {
    photosStore: photos,
    isTakingPhoto,
    isPreviewingPhoto,
    capturePhoto: async (image: string) => {
      return photos.add({ image });
    },
    deletePhoto: async (id: number) => {
      return photos.delete(id);
    }
  };
}
