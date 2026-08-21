import './inProcess/facets/camera';
import { guarded } from './guard';

/**
 * The camera hardware — whether a capture is in flight, and whether the shot just taken
 * is being previewed.
 */
export function useCamera() {
  return guarded('useCamera').facets.camera();
}
