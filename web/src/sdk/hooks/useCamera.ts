import { isTakingPhoto, isPreviewingPhoto } from '../../services/camera';

/**
 * The camera hardware — whether a capture is in flight, and whether the shot just taken
 * is being previewed.
 *
 * The gallery half moved to `useMedia`. One hook covering both meant an app that only
 * wanted to show pictures had to go through something called "camera", and the Photos
 * app did exactly that.
 */
export function useCamera() {
  return {
    isTakingPhoto,
    isPreviewingPhoto
  };
}
