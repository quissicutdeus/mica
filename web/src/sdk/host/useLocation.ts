import './inProcess/facets/location';
import { guarded } from './guard';

/**
 * Share the caller's current in-game position, and set a GPS waypoint from a location a
 * message already carries.
 */
export function useLocation() {
  return guarded('useLocation').facets.location();
}
