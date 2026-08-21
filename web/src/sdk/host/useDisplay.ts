import './inProcess/facets/display';
import { guarded } from './guard';

/**
 * How big the phone is drawn on screen.
 */
export function useDisplay() {
  return guarded('useDisplay').facets.display();
}
